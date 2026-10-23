import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PermanentFailure } from "./index";


export interface ClassifyOptions {
  modelPath: string;
  labelsPath?: string;
  backend?: GpuBackend;
  inputSize?: number; // model is trained for inputSize x inputSize squares
}

export type GpuBackend = "cuda" | "directml";

type Ort = typeof import("onnxruntime-node");
type SharpFactory = (input: string) => {
  resize(width: number, height: number, options: { fit: "fill" }): {
    removeAlpha(): {
      toColourspace(colourspace: "srgb"): {
        raw(): {
          toBuffer(options: { resolveWithObject: true }): Promise<{
            data: Buffer;
            info: { channels: number };
          }>;
        };
      };
    };
  };
};

let ortRuntime: Ort | null = null;
let sharpRuntime: SharpFactory | null = null;
let classifierSession: Awaited<ReturnType<Ort["InferenceSession"]["create"]>> | null = null;
let classifierModelPath = "";
let classifierBackend: GpuBackend | null = null;

async function loadRuntime() {
  if (!ortRuntime) {
    try {
      ortRuntime = await import("onnxruntime-node");
    } catch {
      throw new PermanentFailure(
        "image-classify requires onnxruntime-node. Install the worker's GPU dependencies.",
      );
    }
  }
  if (!sharpRuntime) {
    try {
      sharpRuntime = (await import("sharp")).default as unknown as SharpFactory;
    } catch {
      throw new PermanentFailure(
        "image-classify requires sharp for image decoding. Install the worker's GPU dependencies.",
      );
    }
  }
  return { ort: ortRuntime, sharp: sharpRuntime };
}

function resolveBackend(requested?: GpuBackend): GpuBackend {
  const backend = requested ?? (
    process.env.GPU_BACKEND === "directml"
      ? "directml"
      : process.env.GPU_BACKEND === "cuda" || process.env.USE_CUDA === "1"
        ? "cuda"
        : undefined
  );
  if (!backend) {
    throw new PermanentFailure(
      "image-classify requires a verified GPU backend (CUDA on Linux or DirectML on Windows); it will not silently run on CPU.",
    );
  }
  if (backend === "cuda" && process.platform !== "linux") {
    throw new PermanentFailure("The CUDA worker runtime is supported on Linux x64 only.");
  }
  if (backend === "directml" && process.platform !== "win32") {
    throw new PermanentFailure("The DirectML worker runtime is supported on Windows x64 only.");
  }
  return backend;
}

async function getGpuSession(modelPath: string, requestedBackend?: GpuBackend) {
  const backend = resolveBackend(requestedBackend);
  if (!modelPath) {
    throw new PermanentFailure(
      "image-classify needs MODEL_PATH pointing to a compatible .onnx model file.",
    );
  }
  if (
    classifierSession &&
    classifierModelPath === modelPath &&
    classifierBackend === backend
  ) {
    return { ort: ortRuntime!, session: classifierSession };
  }

  const { ort } = await loadRuntime();
  try {
    classifierSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: backend === "cuda"
        ? ["cuda"]
        : [{
            name: "dml",
            deviceId: Number.parseInt(process.env.GPU_DEVICE_ID ?? "0", 10),
          }],
      graphOptimizationLevel: "all",
      ...(backend === "directml"
        ? { executionMode: "sequential" as const, enableMemPattern: false }
        : {}),
    });
    classifierModelPath = modelPath;
    classifierBackend = backend;
  } catch (error) {
    classifierSession = null;
    classifierModelPath = "";
    classifierBackend = null;
    throw new PermanentFailure(
      backend === "directml"
        ? `Could not initialize image-classify with NVIDIA DirectML. Check that an NVIDIA GPU with a current DirectX 12 driver is available and that MODEL_PATH is valid. ${error instanceof Error ? error.message : ""}`.trim()
        : `Could not initialize image-classify with NVIDIA CUDA. Check the NVIDIA driver, CUDA 13 user-space libraries required by ONNX Runtime 1.30, and MODEL_PATH. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return { ort, session: classifierSession, backend };
}

/** Runs a real inference before the worker is allowed to claim GPU work. */
export async function prepareImageClassifier(options: ClassifyOptions) {
  const { ort, session, backend } = await getGpuSession(options.modelPath, options.backend);
  if (session.inputNames.length === 0) {
    throw new PermanentFailure("Image classification model declares no inputs.");
  }
  const inputName = session.inputNames[0];
  if (!inputName) throw new PermanentFailure("Image classification model declares no inputs.");
  const size = options.inputSize ?? 224;
  const output = await session.run({
    [inputName]: new ort.Tensor(
      "float32",
      new Float32Array(3 * size * size),
      [1, 3, size, size],
    ),
  });
  const logits = Object.values(output)[0]?.data;
  if (!logits || logits.length === 0) {
    throw new PermanentFailure("GPU inference preflight returned no classification scores.");
  }
  return { inputName, backend };
}

export async function runImageClassify(
  inputDir: string,
  items: { path: string }[],
  options: ClassifyOptions,
): Promise<{ lines: string[]; summary: string }> {
  const { ort, sharp } = await loadRuntime();
  const { session, backend } = await getGpuSession(options.modelPath, options.backend);
  const size = options.inputSize ?? 224;

  if (session.inputNames.length === 0) {
    throw new Error("Model declares no inputs");
  }
  const inputName = session.inputNames[0];
  if (!inputName) throw new PermanentFailure("Image classification model declares no inputs.");

  let labels: string[] | null = null;
  if (options.labelsPath) {
    labels = (await fs.readFile(options.labelsPath, "utf8"))
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const lines: string[] = [];
  for (const item of items) {
    const full = join(inputDir, item.path);
    const pixels = await sharp(full)
      .resize(size, size, { fit: "fill" })
      .removeAlpha()
      .toColourspace("srgb")
      .raw()
      .toBuffer({ resolveWithObject: true });

    // ONNX Model Zoo MobileNet v2 expects NCHW RGB, scaled to [0, 1] and
    // normalized with ImageNet channel means and standard deviations.
    const { data, info } = pixels;
    if (info.channels !== 3) {
      throw new PermanentFailure(`Expected a 3-channel RGB image after decoding: ${item.path}`);
    }
    const plane = size * size;
    const float = new Float32Array(3 * plane);
    const means = [0.485, 0.456, 0.406];
    const stds = [0.229, 0.224, 0.225];
    for (let pixel = 0; pixel < plane; pixel++) {
      for (let channel = 0; channel < 3; channel++) {
        const scaled = data[pixel * 3 + channel]! / 255;
        float[channel * plane + pixel] = (scaled - means[channel]!) / stds[channel]!;
      }
    }

    const feeds = {
      [inputName]: new ort.Tensor("float32", float, [1, 3, size, size]),
    };
    const outputs = await session.run(feeds);
    const logits = Object.values(outputs)[0]?.data as
      | ArrayLike<number>
      | undefined;
    if (!logits) throw new Error("Model produced no outputs");

    let topIndex = 0;
    for (let i = 1; i < logits.length; i++) {
      if (logits[i]! > logits[topIndex]!) topIndex = i;
    }
    const label = labels?.[topIndex] ?? `class-${topIndex}`;

    lines.push(
      JSON.stringify({
        file: item.path,
        label,
        classIndex: topIndex,
        confidence: softmaxConfidence(logits, topIndex),
      }),
    );
  }

  return {
    lines,
    summary: `Classified ${items.length} images with ${backend === "cuda" ? "NVIDIA CUDA" : "NVIDIA DirectML"}`,
  };
}

function softmaxConfidence(logits: ArrayLike<number>, index: number): number {
  if (logits.length === 0) throw new Error("Model produced an empty output tensor");
  const max = Array.from(logits).reduce((a, b) => Math.max(a, b), logits[0]!);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i]! - max);
  return Math.exp(logits[index]! - max) / sum;
}

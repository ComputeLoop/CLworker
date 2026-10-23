import { promises as fs } from "node:fs";
import { join } from "node:path";
import { PermanentFailure } from "./index";

/**
 * image-classify: first GPU op.
 *
 * Requires the contributor machine to have:
 *   - `onnxruntime-node`  (CPU by default, CUDA when `onnxruntime-gpu` is
 *     installed and USE_CUDA=1 is set — Bun resolves the same `onnxruntime`
 *     package name for either binary distribution)
 *   - `sharp`             (image decode + resize to the model input)
 *   - A MobileNet-v2 style .onnx model, e.g. from
 *     https://github.com/onnx/models (downloaded to MODEL_PATH)
 *   - Optional MODEL_LABELS=<path to .txt with one label per line>
 *
 * Classes are decided with a softmax over the logits; the top-1 label wins.
 */
export interface ClassifyOptions {
  modelPath: string;
  labelsPath?: string;
  inputSize?: number; // model is trained for inputSize x inputSize squares
}

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

async function getCudaSession(modelPath: string) {
  if (process.env.USE_CUDA !== "1") {
    throw new PermanentFailure(
      "image-classify requires USE_CUDA=1. This operation will not silently run on CPU.",
    );
  }
  if (!modelPath) {
    throw new PermanentFailure(
      "image-classify needs MODEL_PATH pointing to a compatible .onnx model file.",
    );
  }
  if (classifierSession && classifierModelPath === modelPath) {
    return { ort: ortRuntime!, session: classifierSession };
  }

  const { ort } = await loadRuntime();
  try {
    classifierSession = await ort.InferenceSession.create(modelPath, {
      executionProviders: ["cuda"],
      graphOptimizationLevel: "all",
    });
    classifierModelPath = modelPath;
  } catch (error) {
    classifierSession = null;
    classifierModelPath = "";
    throw new PermanentFailure(
      `Could not initialize image-classify with NVIDIA CUDA. Check the NVIDIA driver, CUDA 13 user-space libraries required by ONNX Runtime 1.30, and MODEL_PATH. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return { ort, session: classifierSession };
}

/** Loads the model with CUDA before the worker is allowed to claim GPU work. */
export async function prepareImageClassifier(options: ClassifyOptions) {
  const { session } = await getCudaSession(options.modelPath);
  if (session.inputNames.length === 0) {
    throw new PermanentFailure("Image classification model declares no inputs.");
  }
  const inputName = session.inputNames[0];
  if (!inputName) throw new PermanentFailure("Image classification model declares no inputs.");
  return { inputName };
}

export async function runImageClassify(
  inputDir: string,
  items: { path: string }[],
  options: ClassifyOptions,
): Promise<{ lines: string[]; summary: string }> {
  const { ort, sharp } = await loadRuntime();
  const { session } = await getCudaSession(options.modelPath);
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

  return { lines, summary: `Classified ${items.length} images with CUDA` };
}

function softmaxConfidence(logits: ArrayLike<number>, index: number): number {
  if (logits.length === 0) throw new Error("Model produced an empty output tensor");
  const max = Array.from(logits).reduce((a, b) => Math.max(a, b), logits[0]!);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i]! - max);
  return Math.exp(logits[index]! - max) / sum;
}

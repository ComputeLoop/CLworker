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

export async function runImageClassify(
  inputDir: string,
  items: { path: string }[],
  options: ClassifyOptions,
): Promise<{ lines: string[]; summary: string }> {
  let ort: typeof import("onnxruntime-node");
  try {
    ort = await import("onnxruntime-node");
  } catch {
    throw new PermanentFailure(
      "image-classify requires onnxruntime-node. Install it in the worker: `bun add onnxruntime-node sharp`",
    );
  }

  let sharp: typeof import("sharp");
  try {
    sharp = (await import("sharp")).default as unknown as typeof import("sharp");
  } catch {
    throw new PermanentFailure(
      "image-classify requires sharp for decoding: `bun add onnxruntime-node sharp`",
    );
  }

  if (!options.modelPath) {
    throw new PermanentFailure(
      "image-classify needs MODEL_PATH pointing to a .onnx model file",
    );
  }

  const size = options.inputSize ?? 224;
  const executionProviders = process.env.USE_CUDA === "1" ? ["CUDA", "cpu"] : ["cpu"];

  const session = await ort.InferenceSession.create(options.modelPath, {
    executionProviders,
    graphOptimizationLevel: "all",
  });

  if (session.inputNames.length === 0) {
    throw new Error("Model declares no inputs");
  }
  const inputName = session.inputNames[0];

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
      .raw()
      .toBuffer({ resolveWithObject: true });

    // NHWC float32, normalized to [-1, 1] (ImageNet convention).
    const { data, info } = pixels;
    const float = new Float32Array(size * size * (info.channels ?? 3));
    for (let i = 0; i < float.length; i++) {
      float[i] = (data[i] / 255) * 2 - 1;
    }

    const feeds: Record<string, unknown> = {};
    feeds[inputName] = float;
    const outputs = await session.run(feeds);
    const logits = Object.values(outputs)[0]?.data as
      | ArrayLike<number>
      | undefined;
    if (!logits) throw new Error("Model produced no outputs");

    let topIndex = 0;
    for (let i = 1; i < logits.length; i++) {
      if (logits[i] > logits[topIndex]) topIndex = i;
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

  return { lines, summary: `Classified ${items.length} images` };
}

function softmaxConfidence(logits: ArrayLike<number>, index: number): number {
  const max = Array.from(logits).reduce((a, b) => Math.max(a, b), logits[0]);
  let sum = 0;
  for (let i = 0; i < logits.length; i++) sum += Math.exp(logits[i] - max);
  return Math.exp(logits[index] - max) / sum;
}
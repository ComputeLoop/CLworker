import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runImageHash, writeJsonl } from "./image-hash";
import { runTabularStats } from "./tabular-stats";

export interface ChunkInput {
  kind: "file-list" | "tabular";
  items?: { path: string; size: number; url: string }[];
  rowStart?: number;
  rowEnd?: number;
  header?: string;
}

export interface OpResult {
  summary: string;
  outputPath: string;
}

export class PermanentFailure extends Error {}

export async function runOp(
  opType: string,
  workDir: string,
  inputDir: string,
  outputPath: string,
  input: ChunkInput,
): Promise<OpResult> {
  switch (opType) {
    case "image-hash": {
      const result = await runImageHash(inputDir, input.items ?? []);
      await writeJsonl(outputPath, result.lines);
      return { summary: result.summary, outputPath };
    }

    case "tabular-stats": {
      const chunkText = await fs.readFile(join(inputDir, "chunk.data"), "utf8");
      const stats = runTabularStats(
        chunkText,
        input.header ?? "",
        input.rowStart ?? 0,
        input.rowEnd ?? 0,
      );
      await fs.writeFile(outputPath, JSON.stringify(stats, null, 2) + "\n");
      return {
        summary: `Scanned ${stats.rows} rows across ${stats.columns.length} columns`,
        outputPath,
      };
    }

    case "image-classify": {
      // Loaded on demand so CPU-only contributors never install sharp/onnx.
      const { runImageClassify } = await import("./image-classify");
      const modelPath = process.env.MODEL_PATH ?? "";
      const labelsPath = process.env.MODEL_LABELS;
      const result = await runImageClassify(inputDir, input.items ?? [], {
        modelPath,
        labelsPath,
        backend: process.env.GPU_BACKEND === "directml" || process.env.GPU_BACKEND === "cuda"
          ? process.env.GPU_BACKEND
          : process.env.USE_CUDA === "1"
            ? "cuda"
            : undefined,
      });
      await writeJsonl(outputPath, result.lines);
      return { summary: result.summary, outputPath };
    }

    default:
      throw new Error(`Unknown operation: ${opType}`);
  }
}

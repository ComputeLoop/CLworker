/**
 * Op dispatcher. Each op receives a prepared work directory:
 *   - file-list: inputDir contains the chunk's files at their original paths
 *   - tabular:   inputDir/chunk.data holds the ranged byte slice
 * and writes one output file (JSONL or JSON) to outputPath.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { runImageHash, writeJsonl } from "./image-hash";
import { runTabularStats } from "./tabular-stats";
import { runImageClassify } from "./image-classify";

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

/**
 * Thrown by ops for environment/machine problems that retrying won't fix
 * (missing dependency, missing model file, bad model). The worker reports
 * these to the backend as `permanent` so the chunk goes FAILED immediately
 * instead of burning retries, and the operator fixes the machine then uses
 * the project page's "Requeue" action.
 */
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
      const modelPath = process.env.MODEL_PATH ?? "";
      const labelsPath = process.env.MODEL_LABELS;
      const result = await runImageClassify(inputDir, input.items ?? [], {
        modelPath,
        labelsPath,
      });
      await writeJsonl(outputPath, result.lines);
      return { summary: result.summary, outputPath };
    }

    default:
      throw new Error(`Unknown operation: ${opType}`);
  }
}
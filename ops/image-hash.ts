import { promises as fs } from "node:fs";
import { join } from "node:path";
import { sha256hex } from "./common";
import { imageSize } from "./image-size";

export interface ImageHashRecord {
  file: string;
  size: number;
  sha256: string;
  width: number | null;
  height: number | null;
}

/**
 * image-hash: SHA-256 + dimensions for every file in the chunk's slice.
 * Emits JSONL, one record per file. CPU-only, dependency-free.
 */
export async function runImageHash(
  inputDir: string,
  items: { path: string }[],
): Promise<{ lines: string[]; summary: string }> {
  const records: ImageHashRecord[] = [];
  for (const item of items) {
    const full = join(inputDir, item.path);
    const buf = await fs.readFile(full);
    const size = imageSize(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    records.push({
      file: item.path,
      size: buf.byteLength,
      sha256: sha256hex(buf),
      width: size?.width ?? null,
      height: size?.height ?? null,
    });
  }
  const lines = records.map((r) => JSON.stringify(r));
  return { lines, summary: `Hashed ${records.length} files` };
}

export function writeJsonl(outputPath: string, lines: string[]): Promise<void> {
  return fs.writeFile(outputPath, lines.join("\n") + (lines.length ? "\n" : ""));
}
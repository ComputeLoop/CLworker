import { createHash } from "node:crypto";

export function sha256hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function absoluteUrl(base: string, url: string): string {
  return url.startsWith("http") ? url : `${base}${url}`;
}

/** Best-effort GPU name via nvidia-smi. Returns null when unavailable. */
export function detectGpuName(): string | null {
  try {
    const result = Bun.spawnSync([
      "nvidia-smi",
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    if (result.exitCode !== 0) return null;
    const name = result.stdout.toString().trim();
    return name.length > 0 ? name : null;
  } catch {
    return null;
  }
}
import { createHash } from "node:crypto";

export function sha256hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function absoluteUrl(base: string, url: string): string {
  return url.startsWith("http") ? url : `${base}${url}`;
}

export interface NvidiaGpuInfo {
  name: string;
  vramMb: number | null;
}

/** Best-effort NVIDIA GPU details via nvidia-smi. */
export function detectNvidiaGpu(): NvidiaGpuInfo | null {
  try {
    const result = Bun.spawnSync([
      "nvidia-smi",
      "--query-gpu=name",
      "--format=csv,noheader",
    ]);
    if (result.exitCode !== 0) return null;
    const name = result.stdout.toString().split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!name) return null;
    const memory = Bun.spawnSync([
      "nvidia-smi",
      "--query-gpu=memory.total",
      "--format=csv,noheader,nounits",
    ]);
    const vramMb = memory.exitCode === 0
      ? Number.parseInt(memory.stdout.toString().split(/\r?\n/, 1)[0]?.trim() ?? "", 10)
      : NaN;
    return { name, vramMb: Number.isFinite(vramMb) ? vramMb : null };
  } catch {
    return null;
  }
}

/** Backwards-compatible helper for callers that only need the model name. */
export function detectGpuName(): string | null {
  return detectNvidiaGpu()?.name ?? null;
}

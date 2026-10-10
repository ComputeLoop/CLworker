import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

export const CONFIG_DIR = join(homedir(), ".computeloop");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");

export interface WorkerConfig {
  apiKey?: string;
  apiBase?: string;
  workerId?: string;
  workerName?: string;
  projectId?: string;
}

export function loadConfig(): WorkerConfig {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as WorkerConfig;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

export function saveConfig(patch: Partial<WorkerConfig>): WorkerConfig {
  const next: WorkerConfig = { ...loadConfig(), ...patch };
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", {
    mode: 0o600,
  });
  return next;
}
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { absoluteUrl, detectGpuName, sha256hex } from "./ops/common";
import {
  runOp,
  PermanentFailure,
  type ChunkInput,
  type OpResult,
} from "./ops/index";

export type WorkerLogLevel = "info" | "warn" | "error";

export type WorkerEvent =
  | { type: "log"; level: WorkerLogLevel; message: string }
  | {
      type: "status";
      status:
        | "starting"
        | "claiming"
        | "idle"
        | "processing"
        | "chunk-failed"
        | "stopped"
        | "error";
      detail?: string;
    }
  | {
      type: "chunk";
      phase: "claimed" | "completed" | "failed";
      jobNumber?: number;
      opName?: string;
      summary?: string;
      fatal?: boolean;
    }
  | { type: "progress"; completed: number; total: number };

export interface RunHandle {
  readonly running: boolean;
  stop(): void;
}

export interface RunOptions {
  apiBase: string;
  apiKey: string;
  projectId: string;
  emit?: (event: WorkerEvent) => void;
  pollMs?: number;
  waitMs?: number;
 
  onFatal?: () => void;
}

interface ChunkResponse {
  id: string;
  projectId: string;
  jobNumber: number;
  status: string;
  workerId: string;
  opType: string;
  opName: string;
  gpu: boolean;
  attempts: number;
  input: {
    kind: "file-list" | "tabular";
    items?: { path: string; size: number; url: string }[];
    url?: string;
    range?: { start: number; end: number };
    rowStart?: number;
    rowEnd?: number;
    header?: string;
    bytes?: number;
  };
  output: { key: string; url: string };
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

export function runWorker(options: RunOptions): RunHandle {
  const API_BASE = options.apiBase.replace(/\/$/, "");
  const API_KEY = options.apiKey;
  const PROJECT_ID = options.projectId;
  const POLL_INTERVAL_MS = options.pollMs ?? Number(process.env.WORKER_POLL_MS ?? 2000);
  const WAIT_MS = options.waitMs ?? 3000;
  const emit = options.emit ?? (() => {});
  const onFatal = options.onFatal ?? (() => {});

  const GPU_NAME = detectGpuName();
  let CUDA_READY = false;
  const WORKER_ID = "worker-" + crypto.randomUUID();
  const controller = new AbortController();
  let fatalError = false;

  const log = (level: WorkerLogLevel, message: string) =>
    emit({ type: "log", level, message });

  log("info", `🤖 Worker starting (${WORKER_ID})`);
  log("info", `   API server : ${API_BASE}`);
  log("info", `   Project    : ${PROJECT_ID}`);
  log(
    "info",
    `   GPU        : ${GPU_NAME ?? "none detected (CPU only ops usable)"}`,
  );
  emit({ type: "status", status: "starting" });

  function authHeaders(json = false): Record<string, string> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${API_KEY}`,
    };
    if (json) headers["Content-Type"] = "application/json";
    return headers;
  }

  async function heartbeat() {
    try {
      await fetch(`${API_BASE}/workers/heartbeat`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ gpuName: GPU_NAME, cudaReady: CUDA_READY }),
      });
    } catch {
     
    }
  }

  async function claimChunk(): Promise<ChunkResponse | null> {
    const response = await fetch(
      `${API_BASE}/chunks/next?projectId=${encodeURIComponent(PROJECT_ID)}`,
      { headers: authHeaders(), signal: controller.signal },
    );
    if (response.status === 401) {
      const keyShape = /^clw_[A-Za-z0-9-]+_[0-9a-f]+$/i.test(API_KEY);
      log("error", "🔑 Worker API key rejected by the server.");
      if (!keyShape) {
        log(
          "error",
          `   The key doesn't look like a valid key: "${API_KEY.slice(0, 20)}…"`,
        );
        log(
          "error",
          "   Expected format: clw_<workerId>_<secret>. Make sure there is no stray space/newline",
        );
      } else {
        log(
          "error",
          `   Key ${API_KEY.slice(0, 14)}… was rejected (stale, truncated, or never registered).`,
        );
      }
      log(
        "error",
        "   Fix: open the project's Contribute page and re-register this machine,",
      );
      log(
        "error",
        "   then use the exact WORKER_API_KEY command it shows.",
      );
      fatalError = true;
      emit({ type: "status", status: "error", detail: "worker key rejected" });
      controller.abort();
      onFatal();
      return null;
    }
    if (response.status === 404) return null;
    if (response.status === 409) {
      const body = (await response.json().catch(() => null)) as { message?: string } | null;
      const message = body?.message ?? "This worker is not ready for this operation.";
      log("error", `⚡ ${message}`);
      fatalError = true;
      emit({ type: "status", status: "error", detail: message });
      controller.abort();
      onFatal();
      return null;
    }
    if (!response.ok) {
      log("warn", ` Claim returned HTTP ${response.status}`);
      return null;
    }
    return (await response.json()) as ChunkResponse;
  }

  async function preflightGpuRuntime(): Promise<boolean> {
    let projects: { id: string; gpu?: boolean }[];
    try {
      const response = await fetch(`${API_BASE}/workers/projects`, {
        headers: authHeaders(),
      });
      if (!response.ok) return true;
      projects = (await response.json()) as { id: string; gpu?: boolean }[];
    } catch {
      return true;
    }

    const project = projects.find((item) => item.id === PROJECT_ID);
    const requiresCuda = project?.gpu === true;
    const wantsCuda = process.env.USE_CUDA === "1" && Boolean(process.env.MODEL_PATH);
    if (!requiresCuda && !wantsCuda) {
      CUDA_READY = false;
      await heartbeat();
      return true;
    }

    if (!GPU_NAME) {
      if (!requiresCuda) {
        CUDA_READY = false;
        await heartbeat();
        log("warn", "CUDA was requested but nvidia-smi did not detect an NVIDIA GPU.");
        return true;
      }
      return failGpuPreflight(
        "This is a GPU operation, but nvidia-smi did not detect an NVIDIA GPU. GPU Beta currently requires NVIDIA on Linux x64.",
      );
    }
    if (process.env.USE_CUDA !== "1") {
      if (!requiresCuda) {
        CUDA_READY = false;
        await heartbeat();
        return true;
      }
      return failGpuPreflight(
        "This GPU project needs a CUDA-ready worker. Restart using the Compute Loop contributor launcher so it can detect and prepare GPU support.",
      );
    }
    if (!process.env.MODEL_PATH) {
      if (!requiresCuda) {
        CUDA_READY = false;
        await heartbeat();
        return true;
      }
      return failGpuPreflight("The contributor launcher could not prepare the image-classification model. Restart the launcher to retry setup.");
    }

    try {
      const { prepareImageClassifier } = await import("./ops/image-classify");
      await prepareImageClassifier({
        modelPath: process.env.MODEL_PATH ?? "",
        labelsPath: process.env.MODEL_LABELS,
      });
      CUDA_READY = true;
      await heartbeat();
      log("info", `🟢 CUDA verified on ${GPU_NAME}; GPU work is enabled.`);
      return true;
    } catch (error) {
      if (!requiresCuda) {
        CUDA_READY = false;
        await heartbeat();
        log("warn", `CUDA is not ready; CPU operations remain available: ${error instanceof Error ? error.message : "CUDA preflight failed"}`);
        return true;
      }
      return failGpuPreflight(
        error instanceof Error ? error.message : "Could not initialize the CUDA runtime.",
      );
    }
  }

  async function failGpuPreflight(message: string): Promise<boolean> {
    CUDA_READY = false;
    await heartbeat();
    log("error", `⚡ ${message}`);
    fatalError = true;
    emit({ type: "status", status: "error", detail: "GPU runtime unavailable" });
    controller.abort();
    onFatal();
    return false;
  }

  async function downloadTo(
    url: string,
    dest: string,
    range?: { start: number; end: number },
  ) {
    const headers: Record<string, string> = {};
    if (range) headers["Range"] = `bytes=${range.start}-${range.end}`;
    const response = await fetch(absoluteUrl(API_BASE, url), {
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
    }
    await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
  }

  async function processChunk(chunkIndex: number, chunk: ChunkResponse) {
    emit({ type: "status", status: "processing" });
    emit({
      type: "chunk",
      phase: "claimed",
      jobNumber: chunk.jobNumber,
      opName: chunk.opName,
    });
    log(
      "info",
      `\n📦 [${chunkIndex}] #${chunk.jobNumber} — ${chunk.opName} (${chunk.opType})`,
    );

    const workDir = await mkdtemp(join(tmpdir(), "computeloop-"));
    const inputDir = join(workDir, "input");
    const outputPath = join(workDir, "output");
    const startedAt = Date.now();

    try {
      await mkdir(inputDir, { recursive: true });

      if (chunk.input.kind === "file-list") {
        for (const item of chunk.input.items ?? []) {
          const dest = join(inputDir, item.path);
          await mkdir(join(dest, ".."), { recursive: true });
          log("info", `   ⬇ ${item.path} (${item.size} bytes)`);
          await downloadTo(item.url, dest);
        }
      } else {
        const dest = join(inputDir, "chunk.data");
        log(
          "info",
          `   ⬇ rows ${chunk.input.rowStart}–${chunk.input.rowEnd} (${chunk.input.bytes} bytes, ranged download)`,
        );
        await downloadTo(chunk.input.url ?? "", dest, chunk.input.range);
      }

      log("info", `   🔬 Running ${chunk.opType}...`);
      const result: OpResult = await runOp(
        chunk.opType,
        workDir,
        inputDir,
        outputPath,
        chunk.input as ChunkInput,
      );
      const durationMs = Date.now() - startedAt;

      const outputBytes = await readFile(outputPath);
      const outputHash = sha256hex(outputBytes);

      const uploadResponse = await fetch(
        absoluteUrl(API_BASE, chunk.output.url),
        { method: "PUT", body: outputBytes },
      );
      if (!uploadResponse.ok) {
        throw new Error(`Output upload failed (HTTP ${uploadResponse.status})`);
      }

      const completeResponse = await fetch(
        `${API_BASE}/chunks/${chunk.id}/complete`,
        {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({
            outputHash,
            result: result.summary,
            durationMs,
            gpuName: GPU_NAME,
          }),
        },
      );
      if (!completeResponse.ok) {
        throw new Error(`Complete failed (HTTP ${completeResponse.status})`);
      }

      const complete = (await completeResponse.json()) as {
        job: { status: string };
        project: { completedJobs: number; totalJobs: number } | null;
        merge: { merged: boolean } | null;
      };
      log(
        "info",
        `   ✅ ${result.summary} in ${(durationMs / 1000).toFixed(1)}s — sha256 ${outputHash.slice(0, 12)}…`,
      );
      if (complete.project) {
        log(
          "info",
          `   📈 Project progress: ${complete.project.completedJobs}/${complete.project.totalJobs}`,
        );
        emit({
          type: "progress",
          completed: complete.project.completedJobs,
          total: complete.project.totalJobs,
        });
      }
      if (complete.merge?.merged) {
        log("info", `   🎉 All chunks complete — results merged!`);
      }
      emit({
        type: "chunk",
        phase: "completed",
        jobNumber: chunk.jobNumber,
        opName: chunk.opName,
        summary: result.summary,
      });
    } catch (error) {
      const permanent = error instanceof PermanentFailure;
      const reason =
        error instanceof Error ? error.message.slice(0, 500) : "unknown error";
      log(
        "error",
        `   ❌ Chunk failed${permanent ? " (permanent)" : ""}: ${reason}`,
      );
      if (permanent) {
        log(
          "error",
          "      This is a worker-machine problem (missing dependency/model), not the data.",
        );
        log(
          "error",
          "      Fix it here, then Requeue the failed chunks from the project page in the web UI.",
        );
      }
      emit({
        type: "chunk",
        phase: "failed",
        jobNumber: chunk.jobNumber,
        opName: chunk.opName,
        fatal: permanent,
      });
      emit({ type: "status", status: "chunk-failed" });
      try {
        await fetch(`${API_BASE}/chunks/${chunk.id}/fail`, {
          method: "POST",
          headers: authHeaders(true),
          body: JSON.stringify({ reason, permanent }),
        });
      } catch {
       
      }
    } finally {
      await rm(workDir, { recursive: true, force: true });
    }
  }

  const heartbeatTimer = setInterval(heartbeat, 15_000);

  let finished = false;
  void (async () => {
    let chunkIndex = 0;
    if (!(await preflightGpuRuntime())) {
      finished = true;
      clearInterval(heartbeatTimer);
      return;
    }
    while (!controller.signal.aborted) {
      let job: ChunkResponse | null = null;
      try {
        emit({ type: "status", status: "claiming" });
        job = await claimChunk();
      } catch (error) {
        if (controller.signal.aborted) break;
        log(
          "info",
          `🌐 Connection error: ${error instanceof Error ? error.message : error}`,
        );
      }

      if (job) {
        chunkIndex += 1;
        await processChunk(chunkIndex, job);
      } else if (!controller.signal.aborted) {
        emit({ type: "status", status: "idle" });
        log("info", "📭 No chunks available. Waiting...");
        await delay(WAIT_MS, controller.signal);
      }
    }
    clearInterval(heartbeatTimer);
    finished = true;
    if (!fatalError) emit({ type: "status", status: "stopped" });
  })().catch((error) => {
    clearInterval(heartbeatTimer);
    finished = true;
    log(
      "error",
      `💥 Worker crashed: ${error instanceof Error ? error.message : error}`,
    );
    emit({ type: "status", status: "error", detail: "worker crashed" });
    onFatal();
  });

  return {
    get running() {
      return !finished && !controller.signal.aborted;
    },
    stop() {
      controller.abort();
    },
  };
}

/**
 * Compute Loop contributor worker.
 *
 * Usage:
 *   WORKER_API_KEY=clw_... bun run index.ts <projectId>
 *
 * Env:
 *   COMPUTELOOP_API  backend base URL (default http://localhost:6767)
 *   WORKER_API_KEY   API key created in the web UI (Contribute page)
 *   MODEL_PATH / MODEL_LABELS  (only for the image-classify GPU op)
 *
 * The worker claims chunks, downloads only its slice, runs the platform op,
 * uploads the result, and reports a SHA-256 of the output.
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { absoluteUrl, detectGpuName, sha256hex } from "./ops/common";
import { runOp, PermanentFailure, type ChunkInput, type OpResult } from "./ops/index";

const API_BASE = (process.env.COMPUTELOOP_API ?? "http://localhost:6767").replace(/\/$/, "");
const API_KEY = process.env.WORKER_API_KEY ?? "";
const PROJECT_ID = process.argv[2];

const POLL_INTERVAL_MS = Number(process.env.WORKER_POLL_MS ?? 2000);
const WAIT_MS = 3000;

if (!PROJECT_ID) {
  console.error(
    "❌ Missing project ID.\nUsage: WORKER_API_KEY=clw_... bun run index.ts <projectId>",
  );
  process.exit(1);
}
if (!API_KEY) {
  console.error(
    "❌ Missing WORKER_API_KEY. Create one on the Contribute page of the project in the web UI.",
  );
  process.exit(1);
}

const GPU_NAME = detectGpuName();
const WORKER_ID = "worker-" + crypto.randomUUID();

console.log(`🤖 Worker starting (${WORKER_ID})`);
console.log(`   API server : ${API_BASE}`);
console.log(`   Project    : ${PROJECT_ID}`);
console.log(`   GPU        : ${GPU_NAME ?? "none detected (CPU only ops usable)"}`);

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
      body: JSON.stringify({}),
    });
  } catch {
    // Heartbeat failure is non-fatal; the poll loop will surface problems.
  }
}

async function claimChunk(): Promise<ChunkResponse | null> {
  const response = await fetch(
    `${API_BASE}/chunks/next?projectId=${encodeURIComponent(PROJECT_ID)}`,
    { headers: authHeaders() },
  );
  if (response.status === 401) {
    const keyShape = /^clw_[A-Za-z0-9-]+_[0-9a-f]+$/i.test(API_KEY);
    console.error("🔑 Worker API key rejected by the server.");
    if (!keyShape) {
      console.error(
        `   The key doesn't look like a valid key: "${API_KEY.slice(0, 20)}…"`,
      );
      console.error(
        "   Expected format: clw_<workerId>_<secret>. Make sure there is no stray space/newline",
      );
    } else {
      console.error(
        `   Key ${API_KEY.slice(0, 14)}… was rejected (stale, truncated, or never registered).`,
      );
    }
    console.error(
      "   Fix: open the project's Contribute page and re-register this machine,",
    );
    console.error(
      "   then use the exact WORKER_API_KEY command it shows.",
    );
    process.exit(1);
  }
  if (response.status === 404) return null;
  if (!response.ok) {
    console.warn(`⚠️ Claim returned HTTP ${response.status}`);
    return null;
  }
  return (await response.json()) as ChunkResponse;
}

async function downloadTo(url: string, dest: string, range?: { start: number; end: number }) {
  const headers: Record<string, string> = {};
  if (range) headers["Range"] = `bytes=${range.start}-${range.end}`;
  const response = await fetch(absoluteUrl(API_BASE, url), { headers });
  if (!response.ok) {
    throw new Error(`Download failed (HTTP ${response.status}) for ${url}`);
  }
  await writeFile(dest, new Uint8Array(await response.arrayBuffer()));
}

async function processChunk(chunkIndex: number, chunk: ChunkResponse) {
  console.log(
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
        console.log(`   ⬇ ${item.path} (${item.size} bytes)`);
        await downloadTo(item.url, dest);
      }
    } else {
      const dest = join(inputDir, "chunk.data");
      console.log(
        `   ⬇ rows ${chunk.input.rowStart}–${chunk.input.rowEnd} (${chunk.input.bytes} bytes, ranged download)`,
      );
      await downloadTo(chunk.input.url ?? "", dest, chunk.input.range);
    }

    console.log(`   🔬 Running ${chunk.opType}...`);
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
    console.log(
      `   ✅ ${result.summary} in ${(durationMs / 1000).toFixed(1)}s — sha256 ${outputHash.slice(0, 12)}…`,
    );
    if (complete.project) {
      console.log(
        `   📈 Project progress: ${complete.project.completedJobs}/${complete.project.totalJobs}`,
      );
    }
    if (complete.merge?.merged) {
      console.log(`   🎉 All chunks complete — results merged!`);
    }
  } catch (error) {
    const permanent = error instanceof PermanentFailure;
    const reason =
      error instanceof Error ? error.message.slice(0, 500) : "unknown error";
    console.error(
      `   ❌ Chunk failed${permanent ? " (permanent)" : ""}: ${reason}`,
    );
    if (permanent) {
      console.error(
        "      This is a worker-machine problem (missing dependency/model), not the data.",
      );
      console.error(
        "      Fix it here, then Requeue the failed chunks from the project page in the web UI.",
      );
    }
    try {
      await fetch(`${API_BASE}/chunks/${chunk.id}/fail`, {
        method: "POST",
        headers: authHeaders(true),
        body: JSON.stringify({ reason, permanent }),
      });
    } catch {
      // Nothing more we can do; the lease timeout will requeue it.
    }
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
setInterval(heartbeat, 15_000);

let chunkIndex = 0;
while (true) {
  let job: ChunkResponse | null = null;
  try {
    job = await claimChunk();
  } catch (error) {
    console.log(`🌐 Connection error: ${error instanceof Error ? error.message : error}`);
  }

  if (job) {
    chunkIndex++;
    await processChunk(chunkIndex, job);
  } else {
    console.log("📭 No chunks available. Waiting...");
    await new Promise((resolve) => setTimeout(resolve, WAIT_MS));
  }
}
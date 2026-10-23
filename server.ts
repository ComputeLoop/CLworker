import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, saveConfig, type WorkerConfig } from "./config";
import { runWorker, type RunHandle, type WorkerEvent } from "./runner";

const DEFAULT_API_BASE = (
  process.env.COMPUTELOOP_API ?? "https://cl.elysiavernight.com"
).replace(/\/$/, "");
const HOST = "127.0.0.1";
const PORT = Number(process.env.COMPUTELOOP_UI_PORT ?? 0);

interface ProjectInfo {
  id: string;
  name: string;
  description: string;
  opType: string;
  opName: string;
  gpu: boolean;
  requiresCuda?: boolean;
  owner: string;
  totalJobs: number;
  completedJobs: number;
  pendingJobs: number;
}

let config: WorkerConfig = loadConfig();
let runner: RunHandle | null = null;
let completedChunks = 0;
let status: WorkerEvent | null = null;
let projects: ProjectInfo[] = [];
const subscribers = new Set<(event: WorkerEvent) => void>();

function emit(event: WorkerEvent) {
  if (event.type === "chunk" && event.phase === "completed") {
    completedChunks += 1;
  }
  if (event.type === "status") status = event;
  for (const send of subscribers) {
    try {
      send(event);
    } catch {}
  }
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

function jsonError(message: string, statusCode = 400) {
  return json({ ok: false, error: message }, { status: statusCode });
}

let indexHtml: string | null = null;
function serveIndex() {
  if (indexHtml === null) {
    indexHtml = readFileSync(
      join(import.meta.dir, "static", "index.html"),
      "utf8",
    );
  }
  return new Response(indexHtml, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function validateKey(apiKey: string, apiBase: string) {
  const base = apiBase.replace(/\/$/, "");
  try {
    const response = await fetch(`${base}/workers/me`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (response.status === 401) {
      return {
        ok: false as const,
        error: "Key rejected by the server (stale or mistyped).",
      };
    }
    if (!response.ok) {
      return {
        ok: false as const,
        error: `Server returned HTTP ${response.status}.`,
      };
    }
    const body = (await response.json()) as {
      worker: { id: string; name: string };
    };
    return { ok: true as const, worker: body.worker };
  } catch (error) {
    return {
      ok: false as const,
      error: `Cannot reach server: ${error instanceof Error ? error.message : error}`,
    };
  }
}

async function fetchProjects(
  apiBase: string,
  apiKey: string,
): Promise<ProjectInfo[]> {
  const base = apiBase.replace(/\/$/, "");
  const response = await fetch(`${base}/workers/projects`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) {
    throw new Error(`List projects failed (HTTP ${response.status})`);
  }
  return (await response.json()) as ProjectInfo[];
}

async function handleKey(request: Request) {
  let body: { apiKey?: string; apiBase?: string; forget?: boolean };
  try {
    body = (await request.json()) as {
      apiKey?: string;
      apiBase?: string;
      forget?: boolean;
    };
  } catch {
    return jsonError("Invalid request body.");
  }

  if (body.forget) {
    runner?.stop();
    runner = null;
    config = saveConfig({
      apiKey: undefined,
      workerId: undefined,
      workerName: undefined,
      projectId: undefined,
    });
    return json({ ok: true });
  }

  const apiKey = (body.apiKey ?? "").trim();
  const apiBase = (
    body.apiBase?.trim() ||
    config.apiBase ||
    DEFAULT_API_BASE
  ).replace(/\/$/, "");

  if (!apiKey) return jsonError("Paste your worker key first.");
  if (!/^clw_[A-Za-z0-9-]+_[0-9a-f]+$/i.test(apiKey)) {
    return jsonError(
      "That doesn't look like a Compute Loop key (expected clw_<id>_<secret>).",
    );
  }

  const result = await validateKey(apiKey, apiBase);
  if (!result.ok) return jsonError(result.error);

  config = saveConfig({
    apiKey,
    apiBase,
    workerId: result.worker.id,
    workerName: result.worker.name,
  });
  return json({
    ok: true,
    apiBase,
    worker: { id: result.worker.id, name: result.worker.name },
  });
}

async function handleProjects() {
  if (!config.apiKey) return jsonError("Connect a worker key first.");
  try {
    projects = await fetchProjects(
      config.apiBase ?? DEFAULT_API_BASE,
      config.apiKey,
    );
  } catch (error) {
    return jsonError(
      error instanceof Error ? error.message : "Failed to fetch projects",
    );
  }
  return json(projects);
}

async function handleStart(request: Request) {
  const apiKey = config.apiKey;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  if (!apiKey) return jsonError("Connect a worker key first.");
  if (runner?.running) return jsonError("Worker is already running.");

  let body: { projectId?: string };
  try {
    body = (await request.json()) as { projectId?: string };
  } catch {
    body = {};
  }
  const projectId = (body.projectId ?? "").trim();
  if (!projectId) return jsonError("Pick a project to work on.");

  config = saveConfig({ projectId });
  completedChunks = 0;

  runner = runWorker({
    apiBase,
    apiKey,
    projectId,
    emit,
  });

  return json({ ok: true, projectId });
}

function handleStop() {
  runner?.stop();
  return json({ ok: true });
}

function handleState() {
  return json({
    configured: Boolean(config.apiKey),
    apiBase: config.apiBase ?? DEFAULT_API_BASE,
    worker: config.workerId
      ? { id: config.workerId, name: config.workerName ?? "worker" }
      : null,
    running: runner?.running ?? false,
    projectId: config.projectId ?? null,
    projects,
    completedChunks,
    status: status?.type === "status" ? status.status : null,
    statusDetail: status?.type === "status" ? (status.detail ?? null) : null,
  });
}

function handleEvents() {
  let send: ((event: WorkerEvent) => void) | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      send = (event: WorkerEvent) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      subscribers.add(send);
      if (status) send(status);
    },
    cancel() {
      if (send) subscribers.delete(send);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  fetch(request) {
    const path = new URL(request.url).pathname;
    try {
      if (request.method === "GET" && path === "/") return serveIndex();
      if (request.method === "GET" && path === "/api/state")
        return handleState();
      if (request.method === "GET" && path === "/api/events")
        return handleEvents();
      if (request.method === "GET" && path === "/api/projects")
        return handleProjects();
      if (request.method === "POST" && path === "/api/key")
        return handleKey(request);
      if (request.method === "POST" && path === "/api/start")
        return handleStart(request);
      if (request.method === "POST" && path === "/api/stop")
        return handleStop();
      return new Response("Not found", { status: 404 });
    } catch (error) {
      return jsonError(
        error instanceof Error ? error.message : "Internal error",
        500,
      );
    }
  },
});

function openBrowser(url: string) {
  try {
    if (process.platform === "darwin") {
      Bun.spawn(["open", url]);
    } else if (process.platform === "win32") {
      Bun.spawn(["cmd", "/c", "start", "", url]);
    } else {
      Bun.spawn(["xdg-open", url]);
    }
  } catch {
  
  }
}

export async function startContributorApp() {
  const url = `http://${HOST}:${server.port}`;
  console.log(`Compute Loop contributor app`);
  console.log(`   URL        : ${url}`);
  console.log(`   API server : ${config.apiBase ?? DEFAULT_API_BASE}`);
  if (config.apiKey) {
    console.log(`   Worker     : ${config.workerName ?? "(connected)"}`);
  } else {
    console.log(`   Setup      : paste your worker key to get started`);
  }
  console.log(`   Press Ctrl+C to quit.`);
  openBrowser(url);
}

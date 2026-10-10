# Compute Loop — contributor worker

Agent that runs on contributor machines. It authenticates as a registered
worker, polls the backend for a chunk, downloads exactly the chunk's byte-range
(files or rows) over a signed URL, runs the **platform-standardized op**, uploads
the result, and heartbeats.

Contributors never execute renter code — only the ops in `worker/ops/` (mirroring
`backend/src/operations.ts`).

## Run

### Contributor app (recommended)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.sh)"
```

Installs Bun if needed, downloads the worker, and opens a local control panel
in the browser (`127.0.0.1`). Paste your worker key **once** — it is stored in
`~/.computeloop/config.json` (perms 0600), outside the worker directory — pick
a project, press Start. Key and API URL can also be provided as env vars:

```bash
COMPUTELOOP_API="https://cl.elysiavernight.com" bun run index.ts
```

### Headless / terminal

```bash
bun install                                  # only needed for the GPU op
export WORKER_API_KEY="clw_<worker-key>"     # shown once when you register the worker in the web UI
export COMPUTELOOP_API="http://localhost:6767"  # backend URL (default)
bun run index.ts <project-id>
```

## Options / env

| Env | Default | Purpose |
| --- | --- | --- |
| `WORKER_API_KEY` | — (app stores it) | required for CLI mode; issued once at `POST /workers/register` |
| `COMPUTELOOP_API` | CLI: `http://localhost:6767`, app: `https://cl.elysiavernight.com` | backend URL |
| `COMPUTELOOP_UI_PORT` | free port | local app port (`0` = auto-pick) |
| `WORKER_POLL_MS` | `2000` | idle poll interval |
| `MODEL_PATH` | — | ONNX model for `image-classify` (GPU op) |
| `MODEL_LABELS` | — | one class label per line, matched to output rows |
| `USE_CUDA` | off | prefer CUDA in onnxruntime; falls back to CPU |
| `CL_GPU` | `0` (`start.*`) | set to `1` to `bun install` GPU deps in the one-line installers |

## Ops

| Op | Input chunk | Output |
| --- | --- | --- |
| `image-hash` | a few image files | JSONL: `file, size, sha256, width, height` |
| `tabular-stats` | exact row-range bomb | JSONL: per-column `count/sum/mean/min/max` |
| `image-classify` | a few image files (GPU) | JSONL: per-file top label + confidence |

The worker deletes downloaded chunk data after successful processing. Stale
claims are recycled by the backend after `WORKER_LEASE_MS`; failures retry up to
`MAX_FAIL_ATTEMPTS`.
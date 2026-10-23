# Compute Loop — contributor worker

Agent that runs on contributor machines. It authenticates as a registered
worker, polls the backend for a chunk, downloads exactly the chunk's byte-range
(files or rows) over a signed URL, runs the **platform-standardized op**, uploads
the result, and heartbeats.

Contributors run only the platform-provided ops in `worker/ops/`, selected by the
backend operation registry.

## Run

### Contributor app (recommended)

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.sh)"
```

Installs Bun if needed, downloads the worker, detects NVIDIA CUDA, prepares the
GPU runtime and MobileNet model automatically when supported, then opens a local
control panel in the browser (`127.0.0.1`). Paste your worker key **once** — it is stored in
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
| `MODEL_PATH` | managed by launcher | Compatible MobileNet ONNX model; downloaded automatically for supported Linux NVIDIA GPUs |
| `MODEL_LABELS` | managed by launcher | ImageNet labels; downloaded automatically for supported Linux NVIDIA GPUs |
| `USE_CUDA` | managed by launcher | Set automatically after CUDA and model runtime preflight succeeds |
| `COMPUTELOOP_CUDA_LIBRARY_PATH` | — | optional colon-separated CUDA/cuDNN library directories added to `LD_LIBRARY_PATH` by `start.sh` |

The Beta GPU path currently targets NVIDIA GPUs on Linux x64. The one-paste
launcher detects the GPU, installs ONNX Runtime's CUDA provider, downloads the
model and labels, and validates CUDA before opening the app. A machine without a
working CUDA runtime remains usable for CPU operations, but cannot claim GPU
classification chunks. ONNX Runtime 1.30 requires CUDA 13-compatible user-space
libraries and cuDNN 9. Windows GPU execution is not supported by this worker yet.

## Ops

| Op | Input chunk | Output |
| --- | --- | --- |
| `image-hash` | a few image files | JSONL: `file, size, sha256, width, height` |
| `tabular-stats` | exact row-range byte slice | JSON: per-column `count/sum/mean/min/max` |
| `image-classify` | a few image files (GPU) | JSONL: per-file top label + confidence |

The worker deletes downloaded chunk data after successful processing. Stale
claims are recycled by the backend after `WORKER_LEASE_MS`; failures retry up to
`MAX_FAIL_ATTEMPTS`.

# Compute Loop — contributor worker

Agent that runs on contributor machines. It authenticates as a registered
worker, polls the backend for a chunk, downloads exactly the chunk's byte-range
(files or rows) over a signed URL, runs the **platform-standardized op**, uploads
the result, and heartbeats.

Contributors never execute renter code — only the ops in `worker/ops/` (mirroring
`backend/src/operations.ts`).

## Run

```bash
bun install
export WORKER_API_KEY="clw_<worker-key>"      # shown once when you register the worker in the web UI
export COMPUTELOOP_API="http://localhost:6767"  # backend URL (default)
bun run index.ts <project-id>
```

## Options / env

| Env | Default | Purpose |
| --- | --- | --- |
| `WORKER_API_KEY` | — | required; issued once at `POST /workers/register` |
| `COMPUTELOOP_API` | `http://localhost:6767` | backend URL |
| `WORKER_POLL_MS` | `2000` | idle poll interval |
| `MODEL_PATH` | — | ONNX model for `image-classify` (GPU op) |
| `MODEL_LABELS` | — | one class label per line, matched to output rows |
| `USE_CUDA` | off | prefer CUDA in onnxruntime; falls back to CPU |

## Ops

| Op | Input chunk | Output |
| --- | --- | --- |
| `image-hash` | a few image files | JSONL: `file, size, sha256, width, height` |
| `tabular-stats` | exact row-range bomb | JSONL: per-column `count/sum/mean/min/max` |
| `image-classify` | a few image files (GPU) | JSONL: per-file top label + confidence |

The worker deletes downloaded chunk data after successful processing. Stale
claims are recycled by the backend after `WORKER_LEASE_MS`; failures retry up to
`MAX_FAIL_ATTEMPTS`.
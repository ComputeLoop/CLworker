#!/usr/bin/env bash
# Compute Loop — one-line contributor bootstrap (macOS / Linux)
#
# Run from the Contribute page (the page fills in the environment), e.g.:
#   API_KEY=clw_... PROJECT=<project-id> COMPUTELOOP_API=https://cl.elysiavernight.com \
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.sh)"
#
# What it does: installs Bun if missing, downloads the worker, and runs it.
# CPU ops (image-hash, tabular-stats) need NO dependencies at all. The GPU op
# (image-classify) loads sharp/onnxruntime on demand.

set -euo pipefail

: "${COMPUTELOOP_API:?Set COMPUTELOOP_API to the backend URL (the Contribute page fills this in)}"
: "${API_KEY:?Register a worker on the project first — the Contribute page shows this command}"
: "${PROJECT:?Set PROJECT to the project id (the Contribute page fills this in)}"

echo "→ Compute Loop contributor"
echo "   API server : $COMPUTELOOP_API"
echo "   Project    : $PROJECT"

# 1) Bun runtime ---------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "→ Bun not found, installing…"
  curl -fsSL --connect-timeout 15 --max-time 180 https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# 2) Worker source (fresh copy) ------------------------------------------------
WORKDIR="${CL_WORKER_DIR:-$HOME/.computeloop/worker}"
rm -rf "$WORKDIR"
mkdir -p "$WORKDIR"
echo "→ Fetching worker…"
curl -fsSL --connect-timeout 15 --max-time 180 https://github.com/ComputeLoop/CLworker/archive/refs/heads/master.tar.gz \
  | tar -xz -C "$WORKDIR" --strip-components=1

# 3) Optional dependencies (GPU image-classify only; tolerate failure) ---------
(cd "$WORKDIR" && bun install --ignore-scripts --no-progress >/dev/null 2>&1 || true)

# 4) Run ------------------------------------------------------------------------
export WORKER_API_KEY="$API_KEY"
echo "→ Starting worker for project $PROJECT (Ctrl+C to stop)…"
cd "$WORKDIR"
exec bun run index.ts "$PROJECT"
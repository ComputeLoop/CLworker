#!/usr/bin/env bash
# Compute Loop — one-line contributor bootstrap (macOS / Linux)
#
# Two ways to run it:
#
# A) Contributor app (recommended, no editing):
#     bash -c "$(curl -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.sh)"
#   Opens the local app in your browser. Paste your worker key once, pick a
#   project from the dropdown, press Start. The key is remembered.
#
# B) Headless / CI (key + project baked in, runs in the terminal):
#     API_KEY=clw_... PROJECT=<project-id> COMPUTELOOP_API=https://cl.elysiavernight.com \
#       bash -c "$(curl -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.sh)"
#
# What it does: installs Bun if missing, downloads the worker, and runs it.
# CPU ops need no dependencies. For image-classify GPU work, set CL_GPU=1 on an
# NVIDIA Linux x64 machine with CUDA 13 runtime libraries installed.

set -euo pipefail

: "${COMPUTELOOP_API:=https://cl.elysiavernight.com}"
export COMPUTELOOP_API
if [ -n "${COMPUTELOOP_CUDA_LIBRARY_PATH:-}" ]; then
  export LD_LIBRARY_PATH="${COMPUTELOOP_CUDA_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

if [ -n "${API_KEY:-}" ] && [ -n "${PROJECT:-}" ]; then
  MODE="cli"
else
  MODE="app"
fi

echo "→ Compute Loop contributor ($MODE mode)"
echo "   API server : $COMPUTELOOP_API"
if [ "$MODE" = "cli" ]; then
  echo "   Project    : $PROJECT"
fi

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

# 3) Optional dependencies (NVIDIA CUDA image-classify) ------------------------
if [ "${CL_GPU:-0}" = "1" ]; then
  if [ "$(uname -s)" != "Linux" ] || [ "$(uname -m)" != "x86_64" ]; then
    echo "ERROR: GPU image-classify currently requires Linux x86_64 with NVIDIA CUDA 13-compatible runtime libraries."
    exit 1
  fi
  if ! command -v nvidia-smi >/dev/null 2>&1 || ! nvidia-smi >/dev/null 2>&1; then
    echo "ERROR: CL_GPU=1 requires a working NVIDIA driver and nvidia-smi."
    exit 1
  fi
  cd "$WORKDIR"
  bun install --ignore-scripts --no-progress
  ONNXRUNTIME_NODE_INSTALL=cuda12 bun ./node_modules/onnxruntime-node/script/install.js
fi

# 4) Run ------------------------------------------------------------------------
cd "$WORKDIR"
if [ "$MODE" = "cli" ]; then
  export WORKER_API_KEY="$API_KEY"
  echo "→ Starting worker for project $PROJECT (Ctrl+C to stop)…"
  exec bun run index.ts "$PROJECT"
else
  echo "→ Launching contributor app…"
  exec bun run index.ts
fi

#!/usr/bin/env bash
# Compute Loop — one-line contributor bootstrap (macOS / Linux)
#
# Opens the local contributor app. Paste your worker key, choose a project,
# select the pending chunks to run, then start the contribution.
#
# What it does: installs Bun if missing, downloads the worker, and runs it.
# Detects NVIDIA CUDA and prepares image-classify automatically when possible.
# CPU operations remain available without a supported CUDA runtime.

set -euo pipefail

: "${COMPUTELOOP_API:=https://cl.elysiavernight.com}"
export COMPUTELOOP_API
if [ -n "${COMPUTELOOP_CUDA_LIBRARY_PATH:-}" ]; then
  export LD_LIBRARY_PATH="${COMPUTELOOP_CUDA_LIBRARY_PATH}${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
fi

echo "→ Compute Loop contributor"
echo "   API server : $COMPUTELOOP_API"

# 1) Bun runtime ---------------------------------------------------------------
if ! command -v bun >/dev/null 2>&1; then
  echo "→ Bun not found, installing…"
  curl -fsSL --connect-timeout 15 --max-time 180 https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"

# 2) Worker source (fresh copy) ------------------------------------------------
WORKDIR="${CL_WORKER_DIR:-$HOME/.computeloop/worker}"
mkdir -p "$WORKDIR"
find "$WORKDIR" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
echo "→ Fetching worker…"
curl -fsSL --connect-timeout 15 --max-time 180 https://github.com/ComputeLoop/CLworker/archive/refs/heads/master.tar.gz \
  | tar -xz -C "$WORKDIR" --strip-components=1

# 3) Automatically prepare NVIDIA CUDA image-classify -------------------------
if [ "$(uname -s)" = "Linux" ] && [ "$(uname -m)" = "x86_64" ] \
  && command -v nvidia-smi >/dev/null 2>&1 \
  && nvidia-smi --query-gpu=name --format=csv,noheader >/dev/null 2>&1; then
  GPU_NAME="$(nvidia-smi --query-gpu=name --format=csv,noheader | head -n 1 | xargs)"
  MODEL_DIR="$HOME/.computeloop/models"
  CUDA_LIB_DIR="$HOME/.computeloop/cuda-libs"
  MODEL_PATH="$MODEL_DIR/mobilenetv2-12.onnx"
  MODEL_LABELS="$MODEL_DIR/imagenet-classes.txt"
  mkdir -p "$MODEL_DIR"
  echo "→ NVIDIA GPU detected: $GPU_NAME"
  echo "→ Preparing GPU runtime (first run downloads dependencies and model)…"

  if (
    set -e
    cd "$WORKDIR"
    bun install --ignore-scripts --no-progress
    ONNXRUNTIME_NODE_INSTALL=cuda12 bun ./node_modules/onnxruntime-node/script/install.js
    if [ ! -s "$CUDA_LIB_DIR/nvidia/cu13/lib/libcublasLt.so.13" ] \
      || [ ! -s "$CUDA_LIB_DIR/nvidia/cu13/lib/libcudart.so.13" ] \
      || [ ! -s "$CUDA_LIB_DIR/nvidia/cu13/lib/libcurand.so.10" ] \
      || [ ! -s "$CUDA_LIB_DIR/nvidia/cudnn/lib/libcudnn.so.9" ]; then
      if ! command -v python3 >/dev/null 2>&1; then
        echo "Python 3 is needed to install the missing CUDA runtime libraries."
        exit 1
      fi
      echo "→ Installing CUDA 13 and cuDNN runtime libraries into ~/.computeloop (first setup may download about 1.6 GB)…"
      python3 -m pip install --disable-pip-version-check --no-deps --target "$CUDA_LIB_DIR" \
        'nvidia-cublas==13.4.2.4' \
        'nvidia-cuda-runtime==13.4.92' \
        'nvidia-curand==10.4.4.72' \
        'nvidia-cudnn-cu13==9.27.0.42'
    fi
    export LD_LIBRARY_PATH="$CUDA_LIB_DIR/nvidia/cu13/lib:$CUDA_LIB_DIR/nvidia/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    if [ ! -s "$MODEL_PATH" ]; then
      curl -fL --retry 3 --connect-timeout 20 \
        https://github.com/onnx/models/raw/refs/heads/main/validated/vision/classification/mobilenet/model/mobilenetv2-12.onnx \
        -o "$MODEL_PATH"
    fi
    if [ ! -s "$MODEL_LABELS" ]; then
      curl -fL --retry 3 --connect-timeout 20 \
        https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt \
        -o "$MODEL_LABELS"
    fi
    export USE_CUDA=1 MODEL_PATH MODEL_LABELS
    bun -e 'import { prepareImageClassifier } from "./ops/image-classify.ts"; await prepareImageClassifier({ modelPath: process.env.MODEL_PATH!, labelsPath: process.env.MODEL_LABELS });'
  ); then
    export LD_LIBRARY_PATH="$CUDA_LIB_DIR/nvidia/cu13/lib:$CUDA_LIB_DIR/nvidia/cudnn/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    export USE_CUDA=1 MODEL_PATH MODEL_LABELS
    echo "→ CUDA runtime verified; GPU projects are enabled."
  else
    unset USE_CUDA MODEL_PATH MODEL_LABELS
    echo "⚠ NVIDIA GPU detected, but CUDA could not be initialized."
    echo "  CPU projects remain available; GPU projects will be rejected for this worker."
    echo "  The machine needs CUDA 13-compatible runtime libraries and cuDNN 9."
  fi
else
  unset USE_CUDA MODEL_PATH MODEL_LABELS
  echo "→ No supported NVIDIA CUDA GPU detected. CPU projects remain available; GPU projects will be rejected."
fi

# 4) Run ------------------------------------------------------------------------
cd "$WORKDIR"
echo "→ Launching contributor app…"
exec bun run index.ts

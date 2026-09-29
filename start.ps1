# Compute Loop — one-line contributor bootstrap (Windows PowerShell)
#
# Run from the Contribute page (the page fills in the environment), e.g.:
#   $env:API_KEY="clw_..."; $env:PROJECT="<project-id>"; $env:COMPUTELOOP_API="https://cl.elysiavernight.com"; iex (irm https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.ps1)
#
# What it does: installs Bun if missing, downloads the worker, and runs it.
# CPU ops (image-hash, tabular-stats) need NO dependencies at all. The GPU op
# (image-classify) loads sharp/onnxruntime on demand.

$ErrorActionPreference = "Stop"

if (-not $env:COMPUTELOOP_API) { throw "Set COMPUTELOOP_API to the backend URL (the Contribute page fills this in)." }
if (-not $env:API_KEY) { throw "Register a worker on the project's Contribute page first." }
if (-not $env:PROJECT) { throw "Set PROJECT to the project id (the Contribute page fills this in)." }

Write-Host "→ Compute Loop contributor"
Write-Host "   API server : $env:COMPUTELOOP_API"
Write-Host "   Project    : $env:PROJECT"

# 1) Bun runtime -------------------------------------------------------------
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "→ Bun not found, installing…"
  iex (irm https://bun.sh/install.ps1)
  $env:Path += ";$env:USERPROFILE\.bun\bin"
}

# 2) Worker source (fresh copy) -----------------------------------------------
$temp = Join-Path $env:TEMP "clworker"
$zip = Join-Path $env:TEMP "clworker.zip"
Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $temp | Out-Null
Write-Host "→ Fetching worker…"
Invoke-WebRequest -Uri "https://github.com/ComputeLoop/CLworker/archive/refs/heads/master.zip" -OutFile $zip
Expand-Archive -Path $zip -DestinationPath $temp -Force
Get-ChildItem (Join-Path $temp "CLworker-master") | Move-Item -Destination $temp -Force

# 3) Optional dependencies (GPU image-classify only; tolerate failure) --------
Push-Location $temp
bun install --ignore-scripts --no-progress 2>$null | Out-Null

# 4) Run -----------------------------------------------------------------------
$env:WORKER_API_KEY = $env:API_KEY
Write-Host "→ Starting worker for project $env:PROJECT (Ctrl+C to stop)…"
bun run index.ts $env:PROJECT
Pop-Location
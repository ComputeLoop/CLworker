# Compute Loop — one-line contributor bootstrap (Windows PowerShell)
#
# Run from the Contribute page (the page fills in the environment), e.g.:
#   $env:API_KEY="clw_..."; $env:PROJECT="<project-id>"; $env:COMPUTELOOP_API="https://cl.elysiavernight.com"; iex ((curl.exe -fsSL https://raw.githubusercontent.com/ComputeLoop/CLworker/master/start.ps1) -join ([char]10))
#
# What it does: installs Bun if missing, downloads the worker, and runs it.
# CPU ops (image-hash, tabular-stats) need NO dependencies at all. The GPU op
# (image-classify) loads sharp/onnxruntime on demand.
#
# Downloads use curl.exe (ships with Windows 10 1803+ / 11) instead of
# Invoke-WebRequest / Invoke-RestMethod, which hang on Windows PowerShell 5.1.
# Every download fails loudly within ~15s instead of spinning forever.

$ErrorActionPreference = "Stop"

if (-not $env:COMPUTELOOP_API) { throw "Set COMPUTELOOP_API to the backend URL (the Contribute page fills this in)." }
if (-not $env:API_KEY) { throw "Register a worker on the project's Contribute page first." }
if (-not $env:PROJECT) { throw "Set PROJECT to the project id (the Contribute page fills this in)." }

Write-Host "-> Compute Loop contributor"
Write-Host "   API server : $env:COMPUTELOOP_API"
Write-Host "   Project    : $env:PROJECT"

# --- Download helper: curl.exe first, WebClient + TLS 1.2 as fallback ---------
function Download-File {
  param([string]$Url, [string]$Dest)
  if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
    & curl.exe -fsSL --connect-timeout 15 --max-time 180 -o $Dest $Url
    if ($LASTEXITCODE -ne 0) {
      throw "Download failed (curl exit $LASTEXITCODE). Network blocking GitHub, or URL is wrong: $Url"
    }
  } else {
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    (New-Object System.Net.WebClient).DownloadFile($Url, $Dest)
  }
  if (-not (Test-Path $Dest)) { throw "Download produced no file: $Url" }
  $size = (Get-Item $Dest).Length
  if ($size -lt 1024) { throw "Downloaded file looks empty ($size bytes): $Url" }
}

# 1) Bun runtime -------------------------------------------------------------
if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  Write-Host "-> Bun not found, installing..."
  $installer = Join-Path $env:TEMP "bun-install.ps1"
  Download-File "https://bun.sh/install.ps1" $installer
  try {
    Invoke-Expression (Get-Content -Raw $installer)
  } catch {
    throw "Bun installer failed. See: https://bun.sh/docs/installation"
  }
  $bunBin = Join-Path $env:USERPROFILE ".bun\bin"
  if (-not ($env:Path -like "*$bunBin*")) { $env:Path += ";$bunBin" }
}

# 2) Worker source (fresh copy) ----------------------------------------------
$temp = Join-Path $env:TEMP "clworker"
$zip = Join-Path $env:TEMP "clworker.zip"
Remove-Item -Recurse -Force $temp -ErrorAction SilentlyContinue
Remove-Item -Force $zip -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $temp | Out-Null
Write-Host "-> Fetching worker..."
Download-File "https://github.com/ComputeLoop/CLworker/archive/refs/heads/master.zip" $zip
Expand-Archive -Path $zip -DestinationPath $temp -Force
$src = Join-Path $temp "CLworker-master"
if (-not (Test-Path $src)) { throw "Unexpected archive layout - expected $src" }
Get-ChildItem $src | Move-Item -Destination $temp -Force

# 3) Optional dependencies (GPU image-classify only; tolerate failure) --------
Push-Location $temp
bun install --ignore-scripts --no-progress 2>$null | Out-Null

# 4) Run ----------------------------------------------------------------------
$env:WORKER_API_KEY = $env:API_KEY
Write-Host "-> Starting worker for project $env:PROJECT (Ctrl+C to stop)..."
bun run index.ts $env:PROJECT
Pop-Location
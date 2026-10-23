
$ErrorActionPreference = "Stop"

if (-not $env:COMPUTELOOP_API) { $env:COMPUTELOOP_API = "https://cl.elysiavernight.com" }

Write-Host "-> Compute Loop contributor"
Write-Host "   API server : $env:COMPUTELOOP_API"

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

# 3) Detect GPU capability -----------------------------------------------------
Push-Location $temp
if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
  try {
    $gpuName = (& nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($LASTEXITCODE -eq 0 -and $gpuName) {
      Write-Host "-> NVIDIA GPU detected: $gpuName"
      Write-Host "-> GPU image classification is not supported by this Windows worker yet; CPU projects remain available."
    } else {
      Write-Host "-> No supported CUDA GPU detected. CPU projects remain available; GPU projects will be rejected."
    }
  } catch {
    Write-Host "-> No supported CUDA GPU detected. CPU projects remain available; GPU projects will be rejected."
  }
} else {
  Write-Host "-> No supported CUDA GPU detected. CPU projects remain available; GPU projects will be rejected."
}

# 4) Run ----------------------------------------------------------------------
Write-Host "-> Launching contributor app..."
bun run index.ts
Pop-Location

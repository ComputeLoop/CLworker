$ErrorActionPreference = "Stop"

if (-not $env:COMPUTELOOP_API) { $env:COMPUTELOOP_API = "https://cl.elysiavernight.com" }

Write-Host "-> Compute Loop contributor"
Write-Host "   API server : $env:COMPUTELOOP_API"


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

# 1) Bun runtime 
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

# 2) Worker source (fresh copy)
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

# 3) Install worker dependencies
Push-Location $temp
Write-Host "-> Installing worker dependencies..."
bun install --ignore-scripts --no-progress
if ($LASTEXITCODE -ne 0) { throw "Worker dependency installation failed (bun exit $LASTEXITCODE)." }
bun ./node_modules/onnxruntime-node/script/install.js
if ($LASTEXITCODE -ne 0) { throw "ONNX Runtime installation failed (bun exit $LASTEXITCODE)." }

# 4) Detect NVIDIA and prepare native Windows DirectML 
$nvidiaSmiPath = Join-Path $env:ProgramFiles "NVIDIA Corporation\NVSMI\nvidia-smi.exe"
$nvidiaSmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvidiaSmi -and (Test-Path $nvidiaSmiPath)) { $nvidiaSmi = Get-Item $nvidiaSmiPath }
Remove-Item Env:GPU_BACKEND -ErrorAction SilentlyContinue
Remove-Item Env:GPU_DEVICE_ID -ErrorAction SilentlyContinue
Remove-Item Env:MODEL_PATH -ErrorAction SilentlyContinue
Remove-Item Env:MODEL_LABELS -ErrorAction SilentlyContinue
if ($nvidiaSmi) {
  try {
    $nvidiaSmiExe = if ($nvidiaSmi.Source) { $nvidiaSmi.Source } else { $nvidiaSmi.FullName }
    $gpuName = (& $nvidiaSmiExe --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
    if ($gpuName) { $gpuName = $gpuName.Trim() }
    if ($LASTEXITCODE -eq 0 -and $gpuName) {
      Write-Host "-> NVIDIA GPU detected: $gpuName"
      $modelDir = Join-Path $env:USERPROFILE ".computeloop\models"
      New-Item -ItemType Directory -Path $modelDir -Force | Out-Null
      $env:MODEL_PATH = Join-Path $modelDir "mobilenetv2-12.onnx"
      $env:MODEL_LABELS = Join-Path $modelDir "imagenet-classes.txt"
      $modelUrl = "https://github.com/onnx/models/raw/refs/heads/main/validated/vision/classification/mobilenet/model/mobilenetv2-12.onnx"
      $labelsUrl = "https://raw.githubusercontent.com/pytorch/hub/master/imagenet_classes.txt"
      if (-not (Test-Path $env:MODEL_PATH) -or (Get-Item $env:MODEL_PATH).Length -lt 1024) {
        Write-Host "-> Downloading MobileNet v2 model..."
        Download-File $modelUrl $env:MODEL_PATH
      }
      if (-not (Test-Path $env:MODEL_LABELS) -or (Get-Item $env:MODEL_LABELS).Length -lt 1024) {
        Write-Host "-> Downloading ImageNet labels..."
        Download-File $labelsUrl $env:MODEL_LABELS
      }

      $adapterScript = Join-Path $temp "scripts\DirectMlAdapter.cs"
      Add-Type -Path $adapterScript
      $adapter = [ComputeLoop.DirectMlAdapter]::FindNvidiaAdapter()
      if (-not $adapter) { throw "DirectML could not find an NVIDIA DXGI adapter." }
      $env:GPU_DEVICE_ID = [string]$adapter.DeviceId
      Write-Host "-> NVIDIA DirectML adapter: $($adapter.Name) (adapter $($adapter.DeviceId))"

      $env:GPU_BACKEND = "directml"
      Write-Host "-> Verifying NVIDIA DirectML with a real model inference..."
      bun run .\scripts\preflight-directml.ts
      if ($LASTEXITCODE -eq 0) {
        Write-Host "-> NVIDIA DirectML verified; GPU image classification is enabled."
      } else {
        throw "DirectML inference preflight failed (bun exit $LASTEXITCODE)."
      }
    } else {
      Write-Host "-> No NVIDIA GPU detected. CPU projects remain available."
    }
  } catch {
    Write-Warning "NVIDIA DirectML setup did not complete: $_"
    Write-Host "-> CPU projects remain available; GPU image-classification work will not be claimed."
    Remove-Item Env:GPU_BACKEND -ErrorAction SilentlyContinue
    Remove-Item Env:GPU_DEVICE_ID -ErrorAction SilentlyContinue
    Remove-Item Env:MODEL_PATH -ErrorAction SilentlyContinue
    Remove-Item Env:MODEL_LABELS -ErrorAction SilentlyContinue
  }
} else {
  Write-Host "-> nvidia-smi not found. CPU projects remain available; GPU projects will not be claimed."
}

# 5) Run 
Write-Host "-> Launching contributor app..."
bun run index.ts
Pop-Location

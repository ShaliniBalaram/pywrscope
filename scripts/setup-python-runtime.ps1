# Windows equivalent of setup-python-runtime.sh.
# Fetches python-build-standalone, installs pywr/h5py, and stages the runtime at
# src-tauri/resources/python-runtime so Tauri can bundle it into the installer.

$ErrorActionPreference = "Stop"

$PBS_RELEASE = "20260504"
$PYTHON_VERSION = "3.11.15"
$PYWR_VERSION = "1.30.0"
$H5PY_VERSION = "3.16.0"

$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT_DIR = Split-Path -Parent $SCRIPT_DIR
$DEST_DIR = Join-Path $ROOT_DIR "src-tauri\resources\python-runtime"
$BRIDGE_SCRIPT_SRC = Join-Path $ROOT_DIR "src-tauri\python\run_pywr.py"
$H5_SCRIPT_SRC = Join-Path $ROOT_DIR "src-tauri\python\read_h5.py"
$MARKER = Join-Path $DEST_DIR ".runtime-version"
$MARKER_VALUE = "pbs=$PBS_RELEASE python=$PYTHON_VERSION pywr=$PYWR_VERSION h5py=$H5PY_VERSION"

switch ($env:PROCESSOR_ARCHITECTURE) {
  "AMD64" { $TRIPLE = "x86_64-pc-windows-msvc" }
  default {
    Write-Error "ERROR: unsupported Windows arch: $env:PROCESSOR_ARCHITECTURE"
    exit 1
  }
}

$ASSET = "cpython-$PYTHON_VERSION+$PBS_RELEASE-$TRIPLE-install_only_stripped.tar.gz"
$URL = "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$ASSET"

if ((Test-Path $MARKER) -and ($env:FORCE -ne "1")) {
  $existing = (Get-Content -Raw $MARKER).Trim()
  if ($existing -eq $MARKER_VALUE) {
    Write-Host "[setup-python-runtime] runtime already at pinned version, skipping fetch."
    Copy-Item -Force $BRIDGE_SCRIPT_SRC (Join-Path $DEST_DIR "run_pywr.py")
    Copy-Item -Force $H5_SCRIPT_SRC (Join-Path $DEST_DIR "read_h5.py")
    exit 0
  }
  Write-Host "[setup-python-runtime] marker mismatch; rebuilding runtime."
}

Write-Host "[setup-python-runtime] platform: $TRIPLE"
Write-Host "[setup-python-runtime] target:   $DEST_DIR"
Write-Host "[setup-python-runtime] versions: python=$PYTHON_VERSION pywr=$PYWR_VERSION h5py=$H5PY_VERSION"

if (Test-Path $DEST_DIR) {
  Remove-Item -Recurse -Force $DEST_DIR
}

$DEST_PARENT = Split-Path -Parent $DEST_DIR
if (-not (Test-Path $DEST_PARENT)) {
  New-Item -ItemType Directory -Path $DEST_PARENT -Force | Out-Null
}

$TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TMP_DIR -Force | Out-Null

try {
  Write-Host "[setup-python-runtime] downloading $ASSET..."
  $tarball = Join-Path $TMP_DIR "python.tar.gz"
  Invoke-WebRequest -Uri $URL -OutFile $tarball -UseBasicParsing

  Write-Host "[setup-python-runtime] extracting..."
  tar -xzf $tarball -C $TMP_DIR
  if ($LASTEXITCODE -ne 0) {
    throw "tar extraction failed"
  }

  Move-Item (Join-Path $TMP_DIR "python") $DEST_DIR

  $PY = Join-Path $DEST_DIR "python.exe"
  if (-not (Test-Path $PY)) {
    throw "extracted runtime missing python.exe at $PY"
  }

  $pyver = & $PY --version
  Write-Host "[setup-python-runtime] $pyver"

  Write-Host "[setup-python-runtime] installing pywr==$PYWR_VERSION and h5py==$H5PY_VERSION..."
  & $PY -m pip install --quiet --upgrade pip
  if ($LASTEXITCODE -ne 0) {
    throw "pip upgrade failed"
  }
  & $PY -m pip install --quiet "pywr==$PYWR_VERSION" "h5py==$H5PY_VERSION"
  if ($LASTEXITCODE -ne 0) {
    throw "pywr/h5py install failed"
  }

  & $PY -c "from pywr.model import Model; import pywr, h5py; print(f'[setup-python-runtime] pywr {pywr.__version__}, h5py {h5py.__version__} importable')"
  if ($LASTEXITCODE -ne 0) {
    throw "runtime import smoke test failed"
  }

  Write-Host "[setup-python-runtime] pruning build metadata..."
  & $PY -m pip uninstall --quiet -y pip setuptools wheel 2>$null

  Get-ChildItem -Recurse -Force $DEST_DIR -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  Get-ChildItem -Recurse -Force $DEST_DIR -File -Filter "*.pyc" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
  Get-ChildItem -Recurse -Force $DEST_DIR -Directory -Filter "*.dist-info" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

  Write-Host "[setup-python-runtime] pruning tests and build-time bloat..."
  $SITE_PACKAGES = Join-Path $DEST_DIR "Lib\site-packages"
  if (Test-Path $SITE_PACKAGES) {
    Get-ChildItem -Recurse -Force $SITE_PACKAGES -Directory -Filter "tests" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\tables\\' } |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

    Get-ChildItem -Recurse -Force $SITE_PACKAGES -Directory -Filter "include" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\(numpy|scipy)\\' } |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

    $pywrDir = Join-Path $SITE_PACKAGES "pywr"
    if (Test-Path $pywrDir) {
      Get-ChildItem -Recurse -Force $pywrDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".pyx", ".pxd", ".c") } |
        ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
    }
  }

  & $PY -c "from pywr.model import Model; import h5py; print('[setup-python-runtime] post-prune import OK')"
  if ($LASTEXITCODE -ne 0) {
    throw "post-prune import failed"
  }

  Write-Host "[setup-python-runtime] post-prune smoke test..."
  $SMOKE_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $SMOKE_DIR -Force | Out-Null
  $SMOKE_JSON = Join-Path $SMOKE_DIR "min.json"
  @'
{
  "metadata": {"title": "smoke", "minimum_version": "1.0.0"},
  "timestepper": {"start": "2024-01-01", "end": "2024-01-05", "timestep": 1},
  "nodes": [
    {"name": "Src", "type": "Input", "max_flow": 10},
    {"name": "Snk", "type": "Output", "max_flow": 5, "cost": -100}
  ],
  "edges": [["Src", "Snk"]]
}
'@ | Set-Content -Path $SMOKE_JSON -NoNewline -Encoding UTF8

  $SMOKE_JSON_PY = $SMOKE_JSON.Replace('\', '/')
  & $PY -c "from pywr.model import Model; m = Model.load(r'$SMOKE_JSON_PY'); m.run(); print('[setup-python-runtime] post-prune model run OK')"
  if ($LASTEXITCODE -ne 0) {
    throw "post-prune model run failed"
  }
  Remove-Item -Recurse -Force $SMOKE_DIR -ErrorAction SilentlyContinue

  if (-not (Test-Path $BRIDGE_SCRIPT_SRC)) {
    throw "bridge script not found at $BRIDGE_SCRIPT_SRC"
  }
  Copy-Item -Force $BRIDGE_SCRIPT_SRC (Join-Path $DEST_DIR "run_pywr.py")

  if (-not (Test-Path $H5_SCRIPT_SRC)) {
    throw "h5 reader not found at $H5_SCRIPT_SRC"
  }
  Copy-Item -Force $H5_SCRIPT_SRC (Join-Path $DEST_DIR "read_h5.py")

  Set-Content -Path $MARKER -Value $MARKER_VALUE -NoNewline

  $sizeBytes = (Get-ChildItem -Recurse -Force $DEST_DIR | Measure-Object -Property Length -Sum).Sum
  $sizeMB = [Math]::Round($sizeBytes / 1MB, 1)
  Write-Host "[setup-python-runtime] done. runtime size: $sizeMB MB"
}
finally {
  if (Test-Path $TMP_DIR) {
    Remove-Item -Recurse -Force $TMP_DIR -ErrorAction SilentlyContinue
  }
}

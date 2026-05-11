# scripts/setup-python-runtime.ps1 — Windows equivalent of setup-python-runtime.sh.
# Fetches python-build-standalone, installs pywr, and stages the runtime at
# src-tauri/resources/python-runtime/ so Tauri bundles it into the .exe installer.
# Idempotent: a marker file at the destination encodes the pinned versions;
# reruns skip the download/install when the marker matches.
#
# Why this script exists: Pywr is Python-only. To ship a self-contained Windows
# .exe the user can run without installing anything, we embed CPython + pywr
# as bundle resources. This script is the build-time half; src-tauri/src spawns
# the embedded interpreter at run time.
#
# Pinned versions MUST stay in lock-step with setup-python-runtime.sh — the
# marker value (and so the cache key) is derived from them.
#
# Usage:
#   pwsh ./scripts/setup-python-runtime.ps1                 # build for host
#   $env:FORCE = "1"; pwsh ./scripts/setup-python-runtime.ps1 # rebuild
#
# Requires: PowerShell 7 (pwsh), tar.exe (built into Windows 10+).

$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Pinned versions — keep equal to the .sh sibling.
# ---------------------------------------------------------------------------
$PBS_RELEASE    = "20260504"
$PYTHON_VERSION = "3.11.15"
$PYWR_VERSION   = "1.30.0"

# Project-relative paths.
$SCRIPT_DIR = Split-Path -Parent $MyInvocation.MyCommand.Path
$ROOT_DIR   = Split-Path -Parent $SCRIPT_DIR
$DEST_DIR   = Join-Path $ROOT_DIR "src-tauri\resources\python-runtime"
$BRIDGE_SCRIPT_SRC = Join-Path $ROOT_DIR "src-tauri\python\run_pywr.py"
$H5_SCRIPT_SRC     = Join-Path $ROOT_DIR "src-tauri\python\read_h5.py"
$MARKER       = Join-Path $DEST_DIR ".runtime-version"
$MARKER_VALUE = "pbs=$PBS_RELEASE python=$PYTHON_VERSION pywr=$PYWR_VERSION"

# ---------------------------------------------------------------------------
# Detect arch → python-build-standalone asset triple.
# ---------------------------------------------------------------------------
$arch = $env:PROCESSOR_ARCHITECTURE
switch ($arch) {
  "AMD64" { $TRIPLE = "x86_64-pc-windows-msvc" }
  default {
    Write-Error "ERROR: unsupported Windows arch: $arch (supported: AMD64)"
    exit 1
  }
}

$ASSET = "cpython-$PYTHON_VERSION+$PBS_RELEASE-$TRIPLE-install_only_stripped.tar.gz"
$URL   = "https://github.com/astral-sh/python-build-standalone/releases/download/$PBS_RELEASE/$ASSET"

# ---------------------------------------------------------------------------
# Idempotency check.
# ---------------------------------------------------------------------------
if ((Test-Path $MARKER) -and ($env:FORCE -ne "1")) {
  $existing = (Get-Content -Raw $MARKER).Trim()
  if ($existing -eq $MARKER_VALUE) {
    Write-Host "[setup-python-runtime] runtime already at pinned version, skipping fetch."
    Copy-Item -Force $BRIDGE_SCRIPT_SRC (Join-Path $DEST_DIR "run_pywr.py")
    Copy-Item -Force $H5_SCRIPT_SRC     (Join-Path $DEST_DIR "read_h5.py")
    Write-Host "[setup-python-runtime] bridge script refreshed: $(Join-Path $DEST_DIR 'run_pywr.py')"
    Write-Host "[setup-python-runtime] h5 reader refreshed: $(Join-Path $DEST_DIR 'read_h5.py')"
    exit 0
  }
  Write-Host "[setup-python-runtime] marker mismatch — rebuilding runtime."
}

# ---------------------------------------------------------------------------
# Fresh build.
# ---------------------------------------------------------------------------
Write-Host "[setup-python-runtime] platform: $TRIPLE"
Write-Host "[setup-python-runtime] target:   $DEST_DIR"
Write-Host "[setup-python-runtime] versions: python=$PYTHON_VERSION pywr=$PYWR_VERSION"

if (Test-Path $DEST_DIR) { Remove-Item -Recurse -Force $DEST_DIR }
$DEST_PARENT = Split-Path -Parent $DEST_DIR
if (-not (Test-Path $DEST_PARENT)) { New-Item -ItemType Directory -Path $DEST_PARENT -Force | Out-Null }

$TMP_DIR = Join-Path ([System.IO.Path]::GetTempPath()) ([System.Guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $TMP_DIR -Force | Out-Null

try {
  Write-Host "[setup-python-runtime] downloading $ASSET..."
  $tarball = Join-Path $TMP_DIR "python.tar.gz"
  Invoke-WebRequest -Uri $URL -OutFile $tarball -UseBasicParsing

  Write-Host "[setup-python-runtime] extracting..."
  tar -xzf $tarball -C $TMP_DIR
  if ($LASTEXITCODE -ne 0) { throw "tar extraction failed" }
  Move-Item (Join-Path $TMP_DIR "python") $DEST_DIR

  $PY = Join-Path $DEST_DIR "python.exe"
  if (-not (Test-Path $PY)) {
    Write-Error "ERROR: extracted runtime missing python.exe at $PY"
    exit 1
  }

  $pyver = & $PY --version
  Write-Host "[setup-python-runtime] $pyver"

  Write-Host "[setup-python-runtime] installing pywr==$PYWR_VERSION..."
  & $PY -m pip install --quiet --upgrade pip
  if ($LASTEXITCODE -ne 0) { throw "pip upgrade failed" }
  & $PY -m pip install --quiet "pywr==$PYWR_VERSION"
  if ($LASTEXITCODE -ne 0) { throw "pywr install failed — no Windows wheel for this Python?" }

  & $PY -c "from pywr.model import Model; import pywr; print(f'[setup-python-runtime] pywr {pywr.__version__} importable')"
  if ($LASTEXITCODE -ne 0) { throw "pywr import smoke test failed" }

  # ---------------------------------------------------------------------------
  # Prune. See the .sh sibling for the design rationale — layers, what is
  # safe vs unsafe, and why pandas/plotting + numpy/distutils + numpy/f2py are
  # intentionally NOT pruned.
  # ---------------------------------------------------------------------------
  Write-Host "[setup-python-runtime] pruning (layer 1: build metadata)..."
  & $PY -m pip uninstall --quiet -y pip setuptools wheel 2>$null
  Get-ChildItem -Recurse -Force $DEST_DIR -Directory -Filter "__pycache__" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }
  Get-ChildItem -Recurse -Force $DEST_DIR -File -Filter "*.pyc" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
  Get-ChildItem -Recurse -Force $DEST_DIR -Directory -Filter "*.dist-info" -ErrorAction SilentlyContinue |
    ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

  Write-Host "[setup-python-runtime] pruning (layer 2: tests + build-time bloat)..."
  # On Windows the layout is Lib\site-packages (capital L), not lib/python3.11/site-packages.
  $SITE_PACKAGES = Join-Path $DEST_DIR "Lib\site-packages"
  if (Test-Path $SITE_PACKAGES) {
    # tests/ — drop everywhere except under tables/ (PyTables imports tests at load).
    Get-ChildItem -Recurse -Force $SITE_PACKAGES -Directory -Filter "tests" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\tables\\' } |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

    # numpy + scipy include dirs (C headers; only needed when compiling against them).
    Get-ChildItem -Recurse -Force $SITE_PACKAGES -Directory -Filter "include" -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -match '\\(numpy|scipy)\\' } |
      ForEach-Object { Remove-Item -Recurse -Force $_.FullName -ErrorAction SilentlyContinue }

    # pywr Cython sources (.pyx, .pxd, .c) — the .pyd is the runtime artefact.
    $pywrDir = Join-Path $SITE_PACKAGES "pywr"
    if (Test-Path $pywrDir) {
      Get-ChildItem -Recurse -Force $pywrDir -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -in @(".pyx", ".pxd", ".c") } |
        ForEach-Object { Remove-Item -Force $_.FullName -ErrorAction SilentlyContinue }
    }
  }

  & $PY -c "from pywr.model import Model; print('[setup-python-runtime] post-prune import OK')"
  if ($LASTEXITCODE -ne 0) { throw "post-prune import broke — a layer-2 pattern over-reached" }

  # ---------------------------------------------------------------------------
  # Smoke test — 5-step model run, identical to .sh sibling.
  # ---------------------------------------------------------------------------
  Write-Host "[setup-python-runtime] post-prune smoke test (5-step model)..."
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

  # Pass the path with forward slashes — works on Windows in Python and avoids
  # PowerShell-to-Python string-escape surprises.
  $SMOKE_JSON_PY = $SMOKE_JSON.Replace('\', '/')
  & $PY -c "from pywr.model import Model; m = Model.load(r'$SMOKE_JSON_PY'); m.run(); print('[setup-python-runtime] post-prune model run OK')"
  if ($LASTEXITCODE -ne 0) { throw "post-prune model run failed" }
  Remove-Item -Recurse -Force $SMOKE_DIR -ErrorAction SilentlyContinue

  # ---------------------------------------------------------------------------
  # Stage bridge scripts.
  # ---------------------------------------------------------------------------
  if (-not (Test-Path $BRIDGE_SCRIPT_SRC)) {
    Write-Error "ERROR: bridge script not found at $BRIDGE_SCRIPT_SRC"
    exit 1
  }
  Copy-Item -Force $BRIDGE_SCRIPT_SRC (Join-Path $DEST_DIR "run_pywr.py")

  if (-not (Test-Path $H5_SCRIPT_SRC)) {
    Write-Error "ERROR: h5 reader not found at $H5_SCRIPT_SRC"
    exit 1
  }
  Copy-Item -Force $H5_SCRIPT_SRC (Join-Path $DEST_DIR "read_h5.py")

  # ---------------------------------------------------------------------------
  # Marker file.
  # ---------------------------------------------------------------------------
  Set-Content -Path $MARKER -Value $MARKER_VALUE -NoNewline

  $sizeBytes = (Get-ChildItem -Recurse -Force $DEST_DIR | Measure-Object -Property Length -Sum).Sum
  $sizeMB    = [Math]::Round($sizeBytes / 1MB, 1)
  Write-Host "[setup-python-runtime] done. runtime size: $sizeMB MB"
}
finally {
  if (Test-Path $TMP_DIR) { Remove-Item -Recurse -Force $TMP_DIR -ErrorAction SilentlyContinue }
}

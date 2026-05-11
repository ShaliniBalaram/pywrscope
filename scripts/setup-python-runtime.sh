#!/usr/bin/env bash
# scripts/setup-python-runtime.sh — fetch python-build-standalone, install pywr,
# and stage the runtime at src-tauri/resources/python-runtime/ so Tauri bundles
# it into the app. Idempotent: a marker file at the destination encodes the
# pinned versions; reruns skip the download/install when the marker matches.
#
# Why this script exists at all: Pywr is Python-only. To ship a self-contained
# desktop app the user can run without installing anything, we embed CPython +
# pywr as bundle resources. This script is the build-time half; src-tauri/src
# spawns the embedded interpreter at run time.
#
# Usage:
#   ./scripts/setup-python-runtime.sh         # build for host platform
#   FORCE=1 ./scripts/setup-python-runtime.sh # rebuild even if marker matches
#
# Requires: bash 4+, curl, tar. No system Python required.

set -euo pipefail

# ---------------------------------------------------------------------------
# Pinned versions. Bumping these is the single source of truth — the marker
# file derives from them, so changing either pin forces a rebuild on next run.
# ---------------------------------------------------------------------------
PBS_RELEASE="20260504"
PYTHON_VERSION="3.11.15"
PYWR_VERSION="1.30.0"

# Project-relative paths.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEST_DIR="${ROOT_DIR}/src-tauri/resources/python-runtime"
BRIDGE_SCRIPT_SRC="${ROOT_DIR}/src-tauri/python/run_pywr.py"
H5_SCRIPT_SRC="${ROOT_DIR}/src-tauri/python/read_h5.py"
MARKER="${DEST_DIR}/.runtime-version"
MARKER_VALUE="pbs=${PBS_RELEASE} python=${PYTHON_VERSION} pywr=${PYWR_VERSION}"

# ---------------------------------------------------------------------------
# Detect host platform → python-build-standalone asset triple.
# Windows is intentionally not handled here; a sibling .ps1 script is the right
# home for that since bash on Windows + tar + signing all behave differently.
# ---------------------------------------------------------------------------
detect_triple() {
  local kernel
  local arch
  kernel="$(uname -s)"
  arch="$(uname -m)"
  case "${kernel}-${arch}" in
    Darwin-arm64)   echo "aarch64-apple-darwin" ;;
    Darwin-x86_64)  echo "x86_64-apple-darwin" ;;
    Linux-x86_64)   echo "x86_64-unknown-linux-gnu" ;;
    Linux-aarch64)  echo "aarch64-unknown-linux-gnu" ;;
    *)
      echo "ERROR: unsupported platform: ${kernel}-${arch}" >&2
      echo "Supported: macOS arm64/x86_64, Linux x86_64/aarch64" >&2
      exit 1
      ;;
  esac
}

TRIPLE="$(detect_triple)"
ASSET="cpython-${PYTHON_VERSION}+${PBS_RELEASE}-${TRIPLE}-install_only_stripped.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_RELEASE}/${ASSET}"

# ---------------------------------------------------------------------------
# Idempotency check: skip if the marker matches and FORCE is unset.
# The bridge script is *always* recopied because it lives in the repo — its
# content can change without the runtime changing, and copying is cheap.
# ---------------------------------------------------------------------------
if [[ -f "${MARKER}" && "${FORCE:-}" != "1" ]]; then
  if [[ "$(cat "${MARKER}")" == "${MARKER_VALUE}" ]]; then
    echo "[setup-python-runtime] runtime already at pinned version, skipping fetch."
    cp "${BRIDGE_SCRIPT_SRC}" "${DEST_DIR}/run_pywr.py"
    cp "${H5_SCRIPT_SRC}" "${DEST_DIR}/read_h5.py"
    echo "[setup-python-runtime] bridge script refreshed: ${DEST_DIR}/run_pywr.py"
    echo "[setup-python-runtime] h5 reader refreshed: ${DEST_DIR}/read_h5.py"
    exit 0
  fi
  echo "[setup-python-runtime] marker mismatch — rebuilding runtime."
fi

# ---------------------------------------------------------------------------
# Fresh build.
# ---------------------------------------------------------------------------
echo "[setup-python-runtime] platform: ${TRIPLE}"
echo "[setup-python-runtime] target:   ${DEST_DIR}"
echo "[setup-python-runtime] versions: python=${PYTHON_VERSION} pywr=${PYWR_VERSION}"

rm -rf "${DEST_DIR}"
mkdir -p "$(dirname "${DEST_DIR}")"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

echo "[setup-python-runtime] downloading ${ASSET}..."
curl -fL --progress-bar -o "${TMP_DIR}/python.tar.gz" "${URL}"

echo "[setup-python-runtime] extracting..."
tar -xzf "${TMP_DIR}/python.tar.gz" -C "${TMP_DIR}"
mv "${TMP_DIR}/python" "${DEST_DIR}"

PY="${DEST_DIR}/bin/python3"
if [[ ! -x "${PY}" ]]; then
  echo "ERROR: extracted runtime missing python3 at ${PY}" >&2
  exit 1
fi

echo "[setup-python-runtime] $(${PY} --version)"

echo "[setup-python-runtime] installing pywr==${PYWR_VERSION}..."
"${PY}" -m pip install --quiet --upgrade pip
"${PY}" -m pip install --quiet "pywr==${PYWR_VERSION}"

# Verify the install actually loads — catches broken wheels early so build
# failures don't surface at app-launch time.
"${PY}" -c "from pywr.model import Model; import pywr; print(f'[setup-python-runtime] pywr {pywr.__version__} importable')"

# ---------------------------------------------------------------------------
# Prune. Three layers, ordered by risk.
#
# Layer 1 (always-safe): pip itself, setuptools, wheel, bytecode caches,
# *.dist-info metadata. These drop ~70 MB and have never broken imports.
#
# Layer 2 (deep prune): tests/, C headers (include/), and Cython source files
# (*.pyx, *.pxd, *.c) left behind in pywr after wheels-with-source were
# resolved. These together account for ~3 GB at runtime. Each kind has a clear
# reason it is unreachable at run time:
#   - tests/        : nothing imports them at module load EXCEPT PyTables
#                     (tables/), which is excluded explicitly.
#   - include/      : C headers; only needed when compiling against numpy.
#   - *.pyx/.pxd/.c : Cython sources; the runtime imports the compiled .so.
#
# Three obvious-looking targets are intentionally NOT pruned because they
# break lazy import chains we don't control:
#   - pandas/plotting/  : `pandas.core.series` imports plotting at module
#                         load (matplotlib is the lazy dep, not plotting).
#   - numpy/distutils/  : reachable through `from numpy import *` via numpy's
#                         __getattr__ + __all__ machinery.
#   - numpy/f2py/       : same path; scipy's array_api_compat does
#                         `from numpy import *` during scipy.special init.
# Combined those three are ~190 MB — small relative to the ~3 GB tests/ win,
# not worth the breakage risk.
#
# A post-prune smoke test runs a 5-step model end to end so any surprise
# import path fails the build *here* rather than at app launch.
#
# Layer 3 is intentionally not implemented — selectively dropping scipy
# submodules (signal, ndimage, fftpack, …) would save ~150 MB but Pywr's
# scipy import surface is implicit and brittle, so the smoke test is not a
# strong enough gate. Revisit only if size remains a problem after Layer 2.
# ---------------------------------------------------------------------------
echo "[setup-python-runtime] pruning (layer 1: build metadata)..."
"${PY}" -m pip uninstall --quiet -y pip setuptools wheel || true
find "${DEST_DIR}" -type d -name '__pycache__' -prune -exec rm -rf {} + 2>/dev/null || true
find "${DEST_DIR}" -type f -name '*.pyc' -delete 2>/dev/null || true
find "${DEST_DIR}" -type d -name '*.dist-info' -prune -exec rm -rf {} + 2>/dev/null || true

echo "[setup-python-runtime] pruning (layer 2: tests + build-time bloat)..."
SITE_PACKAGES="${DEST_DIR}/lib/python3.11/site-packages"

# tests/ — drop everywhere except under tables/, which imports tests at module
# load (documented hazard from the original spike notes).
if [[ -d "${SITE_PACKAGES}" ]]; then
  find "${SITE_PACKAGES}" -type d -name 'tests' -prune \
    -not -path "*/tables/*" \
    -exec rm -rf {} + 2>/dev/null || true

  # C/Cython headers + sources. The .so files are the runtime artefacts; the
  # accompanying .pyx/.pxd/.c files are kept by some wheels and are dead weight.
  find "${SITE_PACKAGES}" -type d -name 'include' -prune \
    -path "*/numpy/*" -exec rm -rf {} + 2>/dev/null || true
  find "${SITE_PACKAGES}" -type d -name 'include' -prune \
    -path "*/scipy/*" -exec rm -rf {} + 2>/dev/null || true
  find "${SITE_PACKAGES}/pywr" -type f \( -name '*.pyx' -o -name '*.pxd' -o -name '*.c' \) -delete 2>/dev/null || true
fi

# Re-verify after pruning. Two-stage: (1) bare import for fail-fast feedback,
# (2) actually run a tiny model so any lazy import we accidentally amputated
# fails the build here, not at the user's first run.
"${PY}" -c "from pywr.model import Model; print('[setup-python-runtime] post-prune import OK')"

echo "[setup-python-runtime] post-prune smoke test (5-step model)..."
SMOKE_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}" "${SMOKE_DIR}"' EXIT
cat > "${SMOKE_DIR}/min.json" <<'EOF'
{
  "metadata": {"title": "smoke", "minimum_version": "1.0.0"},
  "timestepper": {"start": "2024-01-01", "end": "2024-01-05", "timestep": 1},
  "nodes": [
    {"name": "Src", "type": "Input", "max_flow": 10},
    {"name": "Snk", "type": "Output", "max_flow": 5, "cost": -100}
  ],
  "edges": [["Src", "Snk"]]
}
EOF
"${PY}" - <<PYEOF
from pywr.model import Model
m = Model.load("${SMOKE_DIR}/min.json")
m.run()
print("[setup-python-runtime] post-prune model run OK")
PYEOF

# ---------------------------------------------------------------------------
# Stage the bridge script into the runtime tree so the runtime is a single
# self-contained directory bundle.resources can ship as one entry.
# ---------------------------------------------------------------------------
if [[ ! -f "${BRIDGE_SCRIPT_SRC}" ]]; then
  echo "ERROR: bridge script not found at ${BRIDGE_SCRIPT_SRC}" >&2
  exit 1
fi
cp "${BRIDGE_SCRIPT_SRC}" "${DEST_DIR}/run_pywr.py"

if [[ ! -f "${H5_SCRIPT_SRC}" ]]; then
  echo "ERROR: h5 reader not found at ${H5_SCRIPT_SRC}" >&2
  exit 1
fi
cp "${H5_SCRIPT_SRC}" "${DEST_DIR}/read_h5.py"

# Mark the runtime as built. The mere presence of this file gates idempotency
# above; its content lets a future bump invalidate the cache automatically.
echo "${MARKER_VALUE}" > "${MARKER}"

SIZE="$(du -sh "${DEST_DIR}" | cut -f1)"
echo "[setup-python-runtime] done. runtime size: ${SIZE}"

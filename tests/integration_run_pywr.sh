#!/usr/bin/env bash
# tests/integration_run_pywr.sh
# Integration test that exercises the Python ↔ Rust event protocol end-to-end
# without standing up the Tauri app. Spawns the bundled runtime against a
# generated minimal model and asserts the JSON-line event stream matches the
# schema documented in src-tauri/python/run_pywr.py.
#
# Run manually:
#   bash tests/integration_run_pywr.sh
#
# Exit code: 0 on success, non-zero on any schema or runtime mismatch.
# CI hookup is a follow-up — needs the runtime to be set up first via
# `npm run setup:python`, which this script depends on.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
RUNTIME="${ROOT_DIR}/src-tauri/resources/python-runtime"
PY="${RUNTIME}/bin/python3"
SCRIPT="${RUNTIME}/run_pywr.py"

if [[ ! -x "${PY}" ]]; then
  echo "FAIL: bundled python missing at ${PY} — run npm run setup:python first" >&2
  exit 1
fi
if [[ ! -f "${SCRIPT}" ]]; then
  echo "FAIL: run_pywr.py missing in runtime — re-run setup:python" >&2
  exit 1
fi

# A throwaway scratch dir keeps the test self-cleaning even on partial failure.
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------------------------------------------------------------------------
# Test 1: happy path — minimal valid model produces started → progress → done.
# ---------------------------------------------------------------------------
cat > "${WORK}/min.json" <<'EOF'
{
  "metadata": {"title": "min", "minimum_version": "1.0.0"},
  "timestepper": {"start": "2024-01-01", "end": "2024-01-05", "timestep": 1},
  "nodes": [
    {"name": "Src", "type": "Input", "max_flow": 10},
    {"name": "Snk", "type": "Output", "max_flow": 5, "cost": -100}
  ],
  "edges": [["Src", "Snk"]],
  "recorders": {
    "Snk_recorder": {"type": "NumpyArrayNodeRecorder", "node": "Snk"}
  }
}
EOF

OUT="$("${PY}" "${SCRIPT}" --model "${WORK}/min.json" --out "${WORK}/results")"

# Each line is one JSON event. Use python to assert the schema instead of a
# brittle grep — the validator stays in lockstep with the producer's schema.
"${PY}" - "${OUT}" <<'PYEOF'
import json, sys
events = [json.loads(l) for l in sys.argv[1].splitlines() if l.strip()]
types = [e["type"] for e in events]
assert types[0] == "started", f"first event must be started, got {types[0]}"
assert "done" in types, f"missing done event in {types}"
assert all(t in ("started", "progress", "done") for t in types), \
    f"happy path emitted unexpected event types: {set(types) - {'started','progress','done'}}"

started = next(e for e in events if e["type"] == "started")
assert started["timesteps_total"] == 5, started

done = next(e for e in events if e["type"] == "done")
assert done["stats"]["timesteps"] == 5, done
assert any(o["name"] == "summary" for o in done["outputs"]), done

# Progress events are well-formed.
progress = [e for e in events if e["type"] == "progress"]
assert progress, "no progress events emitted"
last = progress[-1]
assert last["pct"] == 100, last
assert last["step"] == 5, last

# Per-recorder CSV must include a date header column and one row per timestep.
# This pins the full-timeseries contract documented at the top of run_pywr.py.
import csv, os
rec_outputs = [o for o in done["outputs"] if o["name"] != "summary"]
assert rec_outputs, f"expected at least one recorder CSV in {done['outputs']}"
csv_path = rec_outputs[0]["path"]
assert os.path.isfile(csv_path), f"recorder CSV missing: {csv_path}"
with open(csv_path) as f:
    rows = list(csv.reader(f))
header = rows[0]
assert header and header[0].lower() == "date", \
    f"recorder CSV must start with a 'date' column header, got {header}"
data_rows = rows[1:]
assert len(data_rows) == 5, \
    f"expected 5 timestep rows in {csv_path}, got {len(data_rows)}"
# First-column dates must be ISO-8601 yyyy-mm-dd or the bare run-loop string.
assert all(r[0].startswith("2024-01-") for r in data_rows), \
    f"expected ISO dates in date column, got {[r[0] for r in data_rows]}"

print(f"  happy path: {len(events)} events, {len(progress)} progress steps, "
      f"recorder CSV with {len(data_rows)} rows + date header OK")
PYEOF

# ---------------------------------------------------------------------------
# Test 2: missing-file path — must emit a typed error, not a stack trace.
# ---------------------------------------------------------------------------
set +e
OUT2="$("${PY}" "${SCRIPT}" --model "${WORK}/does-not-exist.json" --out "${WORK}/r2" 2>&1)"
RC=$?
set -e

if [[ "${RC}" == "0" ]]; then
  echo "FAIL: missing-file run should have non-zero exit, got 0" >&2
  exit 1
fi

"${PY}" - "${OUT2}" <<'PYEOF'
import json, sys
lines = [l for l in sys.argv[1].splitlines() if l.strip()]
events = []
for l in lines:
    try: events.append(json.loads(l))
    except Exception: pass
assert events, "expected at least one JSON event on stderr/stdout"
err = next((e for e in events if e["type"] == "error"), None)
assert err is not None, f"no error event in {events}"
assert err["code"] == "MODEL_LOAD_FAILED", err
assert "does-not-exist" in err["message"], err
print(f"  missing-file: error code {err['code']} OK")
PYEOF

# ---------------------------------------------------------------------------
# Test 3: invalid JSON — must emit MODEL_LOAD_FAILED with a traceback.
# ---------------------------------------------------------------------------
echo "not json" > "${WORK}/bad.json"
set +e
OUT3="$("${PY}" "${SCRIPT}" --model "${WORK}/bad.json" --out "${WORK}/r3")"
set -e

"${PY}" - "${OUT3}" <<'PYEOF'
import json, sys
events = [json.loads(l) for l in sys.argv[1].splitlines() if l.strip()]
err = next(e for e in events if e["type"] == "error")
assert err["code"] == "MODEL_LOAD_FAILED", err
assert err["traceback"], "invalid-JSON should include a traceback"
assert "Expecting value" in err["traceback"] or "JSONDecodeError" in err["traceback"], err
print(f"  invalid-json: traceback present OK")
PYEOF

echo "all integration tests passed."

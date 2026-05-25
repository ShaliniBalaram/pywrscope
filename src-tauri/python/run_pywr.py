#!/usr/bin/env python3
# src-tauri/python/run_pywr.py — Pywr model runner invoked by the Rust backend.
#
# Contract: this is the protocol surface between the Tauri Rust process and the
# React UI. Stdout is parsed line-by-line as JSON. Stderr is for diagnostics
# only — never read by the UI. NEVER print non-JSON to stdout: a stray print()
# corrupts the event stream.
#
# Event schema (every stdout line is one of):
#   {"type": "started",   "timesteps_total": int, "model": str}
#   {"type": "progress",  "step": int, "total": int, "pct": int, "date": str}
#   {"type": "done",      "outputs": [{"name": str, "path": str}],
#                         "stats": {"timesteps": int, "scenarios": int, "seconds": float}}
#     - Each non-summary entry in `outputs` is a per-recorder CSV with a
#       leading `date` column (ISO-8601) and one column per scenario.
#   {"type": "error",     "code": str, "message": str, "traceback": str}
#   {"type": "cancelled"}
#
# Error codes (frontend keys actionable hints off these):
#   PYWR_IMPORT_FAILED  — bundled python can't import pywr (broken install)
#   MODEL_LOAD_FAILED   — Model.load() raised (bad JSON, missing parameter, etc.)
#   SOLVER_ERROR        — solver raised mid-step (infeasible LP, etc.)
#   RUN_FAILED          — anything else uncaught
#
# Cancellation: parent sends SIGTERM. Handler flushes a {"type":"cancelled"}
# event then exits 130 (matching Ctrl+C convention).

import argparse
import csv
import json
import math
import signal
import sys
import traceback
from pathlib import Path
from urllib.parse import urlparse, unquote


# Single source of truth for emitting events. flush=True is mandatory — without
# it stdout is block-buffered when piped, so the UI sees nothing until the
# process exits, which defeats the entire progress-stream design.
def json_safe(value):
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {k: json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [json_safe(v) for v in value]
    return value


def emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(json_safe(payload), default=str, allow_nan=False) + "\n")
    sys.stdout.flush()


def fail(code: str, message: str, exc: BaseException | None = None) -> None:
    emit({
        "type": "error",
        "code": code,
        "message": message,
        "traceback": traceback.format_exc() if exc is not None else "",
    })
    sys.exit(1)


EXTERNAL_REF_KEYS = {"url", "path", "file", "filename", "filepath"}
EXTERNAL_REF_SUFFIXES = {
    ".csv", ".xlsx", ".xls", ".xlsm", ".h5", ".hdf5", ".json"
}


def _is_remote_ref(raw: str) -> bool:
    parsed = urlparse(raw)
    # Avoid treating Windows drive letters (C:\...) as URL schemes.
    if len(parsed.scheme) == 1:
        return False
    return parsed.scheme not in {"", "file"}


def _resolve_file_ref(raw: str, model_dir: Path) -> Path:
    parsed = urlparse(raw)
    if parsed.scheme == "file":
        return Path(unquote(parsed.path)).expanduser()
    p = Path(raw).expanduser()
    return p if p.is_absolute() else model_dir / p


def _looks_like_file_ref(key: str | None, value: str, in_includes: bool) -> bool:
    if not value.strip() or _is_remote_ref(value):
        return False
    suffix = Path(urlparse(value).path).suffix.lower()
    if in_includes:
        return suffix == ".json"
    return key in EXTERNAL_REF_KEYS and suffix in EXTERNAL_REF_SUFFIXES


def _iter_external_refs(value, path: str = "$", key: str | None = None):
    if isinstance(value, dict):
        for k, v in value.items():
            child_path = f"{path}.{k}"
            yield from _iter_external_refs(v, child_path, k)
    elif isinstance(value, list):
        in_includes = path == "$.includes"
        for i, v in enumerate(value):
            child_path = f"{path}[{i}]"
            yield from _iter_external_refs(v, child_path, key if in_includes else None)
    elif isinstance(value, str):
        if _looks_like_file_ref(key, value, path.startswith("$.includes")):
            yield path, value


def validate_external_files(model_path: Path) -> None:
    try:
        model = json.loads(model_path.read_text())
    except Exception:
        # Let Model.load produce the canonical Pywr parse error and traceback.
        return

    model_dir = model_path.parent
    missing: list[str] = []
    seen: set[tuple[str, str]] = set()
    for json_path, raw_ref in _iter_external_refs(model):
        key = (json_path, raw_ref)
        if key in seen:
            continue
        seen.add(key)
        resolved = _resolve_file_ref(raw_ref, model_dir)
        if not resolved.exists():
            missing.append(f"{json_path}: {raw_ref} -> {resolved}")

    if missing:
        preview = "\n".join(f"- {m}" for m in missing[:20])
        extra = "" if len(missing) <= 20 else f"\n... and {len(missing) - 20} more"
        fail(
            "MODEL_LOAD_FAILED",
            "Missing external file(s) referenced by model. Keep Excel/CSV/HDF5/"
            "included JSON files in the same folder as the model, or update the "
            f"paths before running:\n{preview}{extra}",
        )


def install_cancel_handler() -> None:
    def handler(signum, _frame):
        emit({"type": "cancelled"})
        # 130 = 128 + SIGINT; conventional exit code for user-cancel.
        sys.exit(130)
    signal.signal(signal.SIGTERM, handler)
    signal.signal(signal.SIGINT, handler)


def main() -> int:
    install_cancel_handler()

    parser = argparse.ArgumentParser(description="Run a Pywr model and stream JSON-line events.")
    parser.add_argument("--model", required=True, help="Absolute path to Pywr model JSON.")
    parser.add_argument("--out", required=True, help="Absolute path to output directory (created if missing).")
    parser.add_argument("--progress-every", type=int, default=0,
                        help="Emit a progress event every N steps. 0 = auto (~1%% of total).")
    args = parser.parse_args()

    model_path = Path(args.model).resolve()
    out_dir = Path(args.out).resolve()

    if not model_path.is_file():
        fail("MODEL_LOAD_FAILED", f"Model file does not exist: {model_path}")

    validate_external_files(model_path)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Imports are inside main() so an import failure surfaces as a typed event
    # rather than a Python traceback dumped to stderr where the UI can't see it.
    try:
        from pywr.model import Model
    except Exception as e:  # noqa: BLE001 — top-level catchall is the point
        fail("PYWR_IMPORT_FAILED",
             f"Could not import pywr from bundled runtime: {e}", e)

    try:
        model = Model.load(str(model_path))
    except Exception as e:  # noqa: BLE001
        fail("MODEL_LOAD_FAILED",
             f"Pywr could not load the model: {e}", e)

    # T2.5 — enable per-route flow capture BEFORE setup so the solver
    # allocates the accumulator. The attribute name and capability vary
    # between Pywr versions and solvers (GLPK has it; the Cython "lp" solver
    # may not), so we set it defensively and remember whether the request
    # was accepted. If the solver doesn't support it, we still run the model;
    # the Sankey tab in the UI will just show "edge flows unavailable" and
    # everything else keeps working.
    routes_flows_enabled = False
    try:
        solver = getattr(model, "solver", None)
        if solver is not None and hasattr(solver, "save_routes_flows"):
            solver.save_routes_flows = True
            routes_flows_enabled = True
    except Exception:  # noqa: BLE001 — feature is best-effort
        routes_flows_enabled = False

    # We drive setup/step/finish ourselves rather than calling model.run() so we
    # can emit per-step progress. This mirrors what model.run() does internally.
    try:
        model.setup()
    except Exception as e:  # noqa: BLE001
        fail("MODEL_LOAD_FAILED",
             f"Pywr setup failed: {e}", e)

    # Compute total step count without consuming the timestepper iterator.
    # model.run() works by looping step() until StopIteration; pre-iterating
    # here would exhaust the generator and step() would StopIteration on call 1.
    # Pywr's Timestepper implements __len__, so this is cheap and non-destructive.
    try:
        total = len(model.timestepper)
    except TypeError:
        total = 0  # Some custom timesteppers may not implement __len__.

    progress_every = args.progress_every or (max(1, total // 100) if total else 1)

    emit({
        "type": "started",
        "model": str(model_path),
        "timesteps_total": total,
    })

    import time
    t0 = time.perf_counter()
    i = 0
    # Step dates are collected here so the CSV writer below can build a date
    # index even when a recorder lacks .to_dataframe(). Cost: one datetime
    # per step (negligible vs a step itself), value: every recorder's CSV
    # ships with timestamps the user can join against.
    step_dates: list[str] = []
    try:
        while True:
            try:
                model.step()
            except StopIteration:
                break
            i += 1
            current = getattr(model.timestepper, "current", None)
            cur_date = getattr(current, "datetime", current) if current is not None else None
            if cur_date is not None:
                step_dates.append(str(cur_date)[:10])
            # Throttle: only emit at the configured stride or on the final step.
            if i % progress_every == 0 or (total and i == total):
                emit({
                    "type": "progress",
                    "step": i,
                    "total": total,
                    "pct": int((i / total) * 100) if total else 0,
                    "date": step_dates[-1] if step_dates else "",
                })
    except Exception as e:  # noqa: BLE001
        try:
            model.finish()
        except Exception:  # noqa: BLE001 — best-effort cleanup
            pass
        fail("SOLVER_ERROR", f"Solver failed at step {i + 1}: {e}", e)

    try:
        model.finish()
    except Exception as e:  # noqa: BLE001
        fail("RUN_FAILED", f"Model finish() failed: {e}", e)

    elapsed = time.perf_counter() - t0

    # Dump recorder values to per-recorder CSVs + a summary.json index.
    # Pywr stores recorders in model.recorders (a NamedIterableContainer keyed
    # by name). Some recorders are aggregate (single value), some are arrays.
    #
    # CSV shape (full timeseries): array recorders are written via
    # rec.to_dataframe().to_csv() so each file has a date column header and
    # one column per scenario. Recorders that don't expose to_dataframe()
    # fall back to numpy + the step_dates list assembled above, producing
    # the same shape (date, value-per-scenario) so downstream tooling can
    # treat every CSV uniformly. Aggregate-only recorders contribute to
    # summary.json and are not written as CSVs.
    outputs = []
    summary = {}
    for rec in model.recorders:
        name = getattr(rec, "name", None) or rec.__class__.__name__

        try:
            agg = float(rec.aggregated_value())
            summary[name] = agg
        except (AttributeError, NotImplementedError, TypeError):
            pass

        csv_path = out_dir / f"{_safe_filename(name)}.csv"
        if _write_recorder_csv(rec, csv_path, step_dates):
            outputs.append({"name": name, "path": str(csv_path)})

    # summary.json is the canonical machine-readable result. The UI reads this
    # to populate the "Run results" view; CSVs are for export to other tools.
    summary_path = out_dir / "summary.json"
    summary_path.write_text(json.dumps(json_safe({
        "model": str(model_path),
        "timesteps": total,
        "scenarios": len(model.scenarios.combinations) if hasattr(model, "scenarios") else 1,
        "seconds": elapsed,
        "recorders": summary,
    }), indent=2, allow_nan=False))
    outputs.append({"name": "summary", "path": str(summary_path)})

    # T2.5 — aggregate per-edge flows from the captured route flows. Output
    # is one JSON file with per-edge sum + annualised values, plus the route
    # decomposition for debugging. Skipped silently when the solver didn't
    # accept save_routes_flows or when route data isn't reachable through
    # the expected attribute names.
    if routes_flows_enabled:
        edge_path = out_dir / "edge_flows.json"
        days_span = total if total else 0
        if _write_edge_flows(model, edge_path, days_span):
            outputs.append({"name": "edge_flows", "path": str(edge_path)})

    h5_path = out_dir / "results.h5"
    if _write_results_h5(outputs, summary, h5_path, model_path, total, elapsed):
        outputs.append({"name": "results_h5", "path": str(h5_path)})

    emit({
        "type": "done",
        "outputs": outputs,
        "stats": {
            "timesteps": total,
            "scenarios": len(model.scenarios.combinations) if hasattr(model, "scenarios") else 1,
            "seconds": round(elapsed, 3),
        },
    })
    return 0


def _safe_filename(name: str) -> str:
    """Replace path-unsafe characters with underscores. Recorder names can
    contain spaces, slashes, or unicode; we keep this conservative."""
    bad = '<>:"/\\|?* '
    return "".join("_" if c in bad else c for c in name) or "recorder"


def _write_recorder_csv(rec, csv_path: Path, step_dates: list) -> bool:
    """Write a single recorder's full timeseries to ``csv_path``.

    Returns True on success, False if the recorder produced no array data
    (caller should skip it from the outputs index in that case).

    Strategy: prefer ``rec.to_dataframe().to_csv()`` because Pywr's NumpyArray
    recorders index the resulting DataFrame by datetime with a per-scenario
    column header — exactly the shape downstream tooling expects. For
    recorders that lack ``to_dataframe()`` (custom recorders, aggregates),
    fall back to ``rec.values()`` + the ``step_dates`` we collected during
    the run, so every CSV emitted from this script has the same first-column
    contract: an ISO-8601 date.
    """
    # Path 1 — DataFrame route. Pywr's NumpyArrayRecorder.to_dataframe()
    # returns a frame with a PeriodIndex on rows and a MultiIndex on columns
    # whose level names are blank. Writing it as-is gives a CSV like
    #     ,0
    #     date,
    #     2024-01-01,5.0
    # because pandas spills the column-level name onto its own row. We flatten
    # the column MultiIndex to single-level "scenario_<n>" labels first so the
    # output matches the "date,scenario_0,...,scenario_n" contract documented
    # at the top of this file.
    try:
        df = rec.to_dataframe()
    except (AttributeError, NotImplementedError, TypeError, ValueError):
        df = None
    if df is not None:
        try:
            cols = df.columns
            if cols.nlevels > 1:
                df.columns = [
                    "scenario_" + "_".join(str(p) for p in tup) for tup in cols
                ]
            else:
                # 1-level MultiIndex → flatten to a plain Index of scenario_<i>.
                df.columns = [f"scenario_{c}" for c in range(len(cols))]
            df.to_csv(csv_path, index_label="date")
            return True
        except Exception:  # noqa: BLE001 — fall through to the numpy path
            pass

    # Path 2 — numpy fallback. We assemble the same (date, *scenarios)
    # layout by hand so the consumer doesn't need to detect which path
    # produced the file.
    try:
        values = rec.values()
    except (AttributeError, NotImplementedError):
        return False
    if values is None:
        return False

    try:
        import numpy as np
        arr = np.asarray(values)
        if arr.size == 0:
            return False
        # Reshape to (rows, scenarios). Recorders return either a 1-D series
        # (single-scenario) or a 2-D (timesteps, scenarios) array.
        if arr.ndim == 1:
            arr = arr.reshape(-1, 1)
        elif arr.ndim > 2:
            arr = arr.reshape(arr.shape[0], -1)
        rows, cols = arr.shape

        # Build the date column. If we have fewer dates than rows we pad with
        # blanks rather than failing — the data is still useful, and a missing
        # date is a clearer signal than a silent truncation.
        dates = list(step_dates[:rows]) + [""] * max(0, rows - len(step_dates))

        header = "date," + ",".join(f"scenario_{c}" for c in range(cols))
        with open(csv_path, "w", encoding="utf-8") as f:
            f.write(header + "\n")
            for d, row in zip(dates, arr):
                f.write(d + "," + ",".join(f"{v:.6g}" for v in row) + "\n")
        return True
    except Exception:  # noqa: BLE001 — recorder serialisation is best-effort
        return False


def _write_results_h5(
    outputs: list[dict],
    summary: dict,
    h5_path: Path,
    model_path: Path,
    timesteps: int,
    seconds: float,
) -> bool:
    """Write all per-recorder CSV outputs into one portable HDF5 file.

    Schema:
      /recorders/<safe-recorder-name>/date    string[N]
      /recorders/<safe-recorder-name>/values  float[N, scenarios]
      /summary/recorders_json                 JSON string of aggregate values

    H5 is an optional export format. If h5py is unavailable, skip quietly so a
    stripped runtime can still run models and emit CSV/JSON outputs.
    """
    try:
        import h5py
        import numpy as np
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"h5 output skipped: h5py/numpy unavailable: {e}\n")
        return False

    recorder_outputs = [
        o for o in outputs
        if str(o.get("path", "")).lower().endswith(".csv")
    ]
    if not recorder_outputs and not summary:
        return False

    try:
        with h5py.File(h5_path, "w") as h5:
            h5.attrs["model"] = str(model_path)
            h5.attrs["timesteps"] = timesteps
            h5.attrs["seconds"] = seconds

            rec_root = h5.create_group("recorders")
            string_dtype = h5py.string_dtype(encoding="utf-8")
            for output in recorder_outputs:
                name = str(output.get("name", "recorder"))
                path = Path(str(output.get("path", "")))
                if not path.is_file():
                    continue
                with path.open("r", encoding="utf-8", newline="") as f:
                    rows = list(csv.reader(f))
                if not rows:
                    continue

                headers = rows[0]
                dates: list[str] = []
                values: list[list[float]] = []
                for row in rows[1:]:
                    if not row:
                        continue
                    dates.append(row[0])
                    vals = []
                    for cell in row[1:]:
                        try:
                            vals.append(float(cell))
                        except ValueError:
                            vals.append(float("nan"))
                    values.append(vals)

                width = max((len(v) for v in values), default=max(0, len(headers) - 1))
                arr = np.full((len(values), width), np.nan, dtype=float)
                for r, vals in enumerate(values):
                    arr[r, :len(vals)] = vals

                group = rec_root.create_group(_safe_filename(name))
                group.attrs["name"] = name
                group.attrs["source_csv"] = str(path)
                group.attrs["columns_json"] = json.dumps(headers[1:])
                group.create_dataset("date", data=np.asarray(dates, dtype=object), dtype=string_dtype)
                group.create_dataset("values", data=arr, compression="gzip")

            summary_group = h5.create_group("summary")
            summary_group.create_dataset(
                "recorders_json",
                data=json.dumps(json_safe(summary), default=str, allow_nan=False),
                dtype=string_dtype,
            )
        return True
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"h5 output skipped: {e}\n")
        return False


def _write_edge_flows(model, edge_path: Path, days_span: int) -> bool:
    """Write per-edge aggregated flows to ``edge_path`` as JSON.

    Output schema:
        {
          "edges": [{"u": str, "v": str, "total": float, "annual": float}, ...],
          "totalRoutes": int,
          "timesteps": int,
        }

    The Sankey view in the UI consumes this directly. Annual is total / days
    × 365.25 when ``days_span`` > 0; otherwise NaN (rendered as ``null`` in
    JSON for the UI to handle).

    Implementation notes:
      - Pywr 1.x captures per-route per-timestep flow as a 3-D array shaped
        (timesteps, routes, scenarios) when ``save_routes_flows=True``. The
        attribute name and exact shape varies — we try a few known names and
        fall back gracefully.
      - A route is a sequence of nodes from a supply (Input/Catchment) to a
        demand (Output) along the LP graph. Consecutive node pairs map to
        edges in the user-visible network.
      - We sum the route flow across timesteps and scenarios (averaged across
        scenarios so the number stays comparable to a single-scenario run),
        then distribute the route total to each consecutive edge along the
        route's node path.

    Returns True on success, False on any failure (caller skips the output
    entry). We surface failures only to stderr because the Sankey is an
    optional feature — a missing edge_flows.json should not derail the run.
    """
    try:
        import numpy as np
    except Exception as e:  # noqa: BLE001 — numpy is required everywhere else,
        # but we keep this defensive in case a stripped-down build is in use.
        sys.stderr.write(f"edge_flows: numpy unavailable: {e}\n")
        return False

    solver = getattr(model, "solver", None)
    if solver is None:
        return False

    # Try the known attribute names for the captured per-route flow array.
    # Order matters: prefer the most-explicit name first. Each attribute is
    # expected to be a NumPy-compatible array with shape (..., n_routes, ...).
    routes_flows = None
    for attr in ("all_routes_flows", "routes_flows", "_routes_flows_array"):
        try:
            candidate = getattr(solver, attr, None)
        except Exception:  # noqa: BLE001
            candidate = None
        if candidate is None:
            continue
        try:
            arr = np.asarray(candidate)
        except Exception:  # noqa: BLE001
            continue
        if arr.size > 0:
            routes_flows = arr
            break
    if routes_flows is None:
        sys.stderr.write("edge_flows: solver did not expose per-route flow data\n")
        return False

    # Extract the route definitions. Routes can be either a list of node
    # objects with .name, or a list of name strings. We normalise to lists
    # of name strings.
    try:
        raw_routes = list(getattr(solver, "routes"))
    except Exception:  # noqa: BLE001
        sys.stderr.write("edge_flows: solver did not expose routes list\n")
        return False
    if not raw_routes:
        sys.stderr.write("edge_flows: solver routes list is empty\n")
        return False

    routes_nodes: list[list[str]] = []
    for r in raw_routes:
        # `r` is normally a Route object with .nodes list, or a plain
        # iterable of node objects. We handle both shapes.
        seq = getattr(r, "nodes", None)
        if seq is None:
            try:
                seq = list(r)
            except TypeError:
                continue
        names: list[str] = []
        for n in seq:
            name = getattr(n, "name", None)
            if name is None and isinstance(n, str):
                name = n
            if name is None:
                names = []  # bail on this route
                break
            names.append(name)
        if len(names) >= 2:
            routes_nodes.append(names)

    if not routes_nodes:
        sys.stderr.write("edge_flows: no usable routes after name extraction\n")
        return False

    # Reduce routes_flows to per-route totals (sum over time, mean over
    # scenarios). The captured shape across Pywr versions is typically one
    # of (t, r), (t, r, s), or (r, s) — locate the axis with len == len(routes)
    # and reduce the others.
    n_routes = len(routes_nodes)
    try:
        per_route_total = _reduce_routes_flows(routes_flows, n_routes)
    except Exception as e:  # noqa: BLE001
        sys.stderr.write(f"edge_flows: could not reduce route flow array: {e}\n")
        return False

    if per_route_total is None:
        sys.stderr.write(
            f"edge_flows: route flow array shape {routes_flows.shape} "
            f"could not be aligned to {n_routes} routes\n"
        )
        return False

    # Distribute each route's total to its consecutive (u, v) edge pairs.
    # A route covers every edge along its path equally — the same volume of
    # water flowed through every edge of the route.
    edge_totals: dict[tuple[str, str], float] = {}
    for route_idx, names in enumerate(routes_nodes):
        if route_idx >= per_route_total.shape[0]:
            break
        flow = float(per_route_total[route_idx])
        if flow == 0.0:
            continue
        for i in range(len(names) - 1):
            key = (names[i], names[i + 1])
            edge_totals[key] = edge_totals.get(key, 0.0) + flow

    out_edges = []
    for (u, v), total in edge_totals.items():
        annual = (total * 365.25 / days_span) if days_span else None
        out_edges.append({
            "u": u,
            "v": v,
            "total": total,
            "annual": annual,
        })

    payload = {
        "edges": out_edges,
        "totalRoutes": n_routes,
        "timesteps": days_span,
    }
    edge_path.write_text(json.dumps(json_safe(payload), indent=2, allow_nan=False))
    return True


def _reduce_routes_flows(arr, n_routes: int):
    """Reduce a route-flow array to per-route totals.

    Strategy: find the axis whose length equals ``n_routes`` and treat that
    as the route axis. Sum across every other axis EXCEPT the inferred
    scenario axis (handled below). Returns a 1-D array of length
    ``n_routes`` (or None when shape can't be aligned).

    Scenario handling: if the array has a third axis with length > 1, we
    average across it so a multi-scenario model produces a single Sankey
    that reads like a single run. The mass-balance and reliability views
    use the same convention.
    """
    import numpy as np
    arr = np.asarray(arr)
    shape = arr.shape
    # Find the route axis.
    route_axes = [i for i, n in enumerate(shape) if n == n_routes]
    if not route_axes:
        return None
    # Prefer the largest-index route axis (often time-major shapes put
    # routes at axis 1 or 2 with scenarios as the last axis).
    route_axis = route_axes[-1]

    # Move routes to axis 0, then sum along the time axis and mean along
    # any remaining axes (scenarios).
    arr2 = np.moveaxis(arr, route_axis, 0)
    # arr2 shape: (n_routes, *rest). We sum across rest (totals over time
    # and scenarios) then divide by scenario count.
    if arr2.ndim == 1:
        return arr2.astype("float64", copy=False)
    # Identify scenario axis: typically the last remaining axis if it's
    # smaller than the leading axis (time). Without strong invariants we
    # treat all remaining axes as one — sum gives the total flow-volume.
    # For a multi-scenario run with shape (n_routes, n_timesteps, n_scen)
    # the sum is total_volume × n_scen, so we divide by n_scen to recover
    # an averaged total. We approximate n_scen as the size of the last axis.
    n_scen = arr2.shape[-1] if arr2.ndim >= 3 else 1
    summed = arr2.reshape(arr2.shape[0], -1).sum(axis=1)
    if n_scen > 1:
        summed = summed / float(n_scen)
    return summed.astype("float64", copy=False)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001 — last-resort catchall so we never
        # exit with a stderr-only traceback the UI can't see.
        fail("RUN_FAILED", f"Uncaught exception: {e}", e)

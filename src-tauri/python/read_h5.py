#!/usr/bin/env python3
# src-tauri/python/read_h5.py — HDF5 results reader invoked by the Rust backend.
#
# Two operating modes, selected by --mode:
#   list    — emit the dataset tree of an .h5/.hdf5 file as one JSON line
#   preview — emit a tabular preview of a chosen dataset
#
# Protocol contract: stdout = one JSON object on a single line. Stderr is
# diagnostics only. Errors are emitted as {"ok": false, "error": "..."} so the
# Rust caller can always parse stdout (success and failure share one shape).
#
# Why a sidecar instead of Rust-native HDF5? The `hdf5` Rust crate links against
# libhdf5 dynamically and would force users to install it. Pywr already ships
# h5py via tables (or directly), so we reuse the bundled interpreter and avoid
# adding a system dependency.

import argparse
import json
import sys
import traceback


def emit_ok(payload: dict) -> int:
    sys.stdout.write(json.dumps({"ok": True, **payload}, default=str) + "\n")
    sys.stdout.flush()
    return 0


def emit_err(message: str, exc: BaseException | None = None) -> int:
    sys.stdout.write(json.dumps({
        "ok": False,
        "error": message,
        "traceback": traceback.format_exc() if exc is not None else "",
    }) + "\n")
    sys.stdout.flush()
    return 1


def list_datasets(path: str) -> int:
    try:
        import h5py  # noqa: F401
    except Exception as e:  # noqa: BLE001
        return emit_err(f"h5py is not available in the bundled runtime: {e}", e)

    try:
        import h5py
        datasets = []
        with h5py.File(path, "r") as f:
            def visitor(name, obj):
                # h5py walks groups and datasets; we only surface datasets so
                # the UI list maps 1:1 to selectable tables.
                if isinstance(obj, h5py.Dataset):
                    shape = list(obj.shape)
                    dtype = str(obj.dtype)
                    datasets.append({
                        "name": name,
                        "shape": shape,
                        "dtype": dtype,
                        "size": int(obj.size),
                    })
            f.visititems(visitor)
        return emit_ok({"datasets": datasets})
    except Exception as e:  # noqa: BLE001
        return emit_err(f"Failed to read HDF5 file: {e}", e)


def preview_dataset(path: str, dataset: str, max_rows: int) -> int:
    try:
        import h5py
        import numpy as np
    except Exception as e:  # noqa: BLE001
        return emit_err(f"h5py / numpy unavailable: {e}", e)

    try:
        with h5py.File(path, "r") as f:
            if dataset not in f:
                return emit_err(f"Dataset '{dataset}' not found in {path}")
            ds = f[dataset]
            shape = list(ds.shape)
            total = int(ds.shape[0]) if ds.ndim >= 1 else 1

            # 0-d scalar dataset — return a single cell.
            if ds.ndim == 0:
                val = ds[()]
                return emit_ok({
                    "headers": ["value"],
                    "rows": [[_safe(val)]],
                    "shape": shape,
                    "total_rows": 1,
                    "returned_rows": 1,
                })

            n = min(max_rows, total)
            arr = np.asarray(ds[0:n])

            if arr.ndim == 1:
                headers = ["value"]
                rows = [[_safe(v)] for v in arr]
            else:
                # Flatten higher dims into "col_0 ... col_{n-1}" for the table view.
                if arr.ndim > 2:
                    arr = arr.reshape(arr.shape[0], -1)
                ncols = arr.shape[1]
                headers = [f"col_{i}" for i in range(ncols)]
                rows = [[_safe(v) for v in row] for row in arr]

            # Pull a 1-D index column if the file follows the pandas-on-HDF
            # convention of storing an `axis1` or `index` sibling. Pywr's
            # default H5 writer (via tables) writes a `block0_values` + `axis1`
            # pair per group; surface `axis1` as a leading column when present.
            parent = ds.parent
            index_col = None
            for cand in ("axis1", "index", "Date", "date"):
                if cand in parent and parent[cand].shape[:1] == ds.shape[:1]:
                    index_col = list(parent[cand][0:n])
                    break
            if index_col is not None:
                headers = ["index"] + headers
                rows = [[_safe(idx)] + r for idx, r in zip(index_col, rows)]

            return emit_ok({
                "headers": headers,
                "rows": rows,
                "shape": shape,
                "total_rows": total,
                "returned_rows": n,
            })
    except Exception as e:  # noqa: BLE001
        return emit_err(f"Failed to preview dataset: {e}", e)


def _safe(v):
    """Convert numpy / bytes scalars to JSON-serialisable primitives. Anything
    we can't recognise is stringified rather than dropped — losing a cell is a
    worse UX than showing its repr."""
    try:
        import numpy as np
        if isinstance(v, (bytes, bytearray)):
            return v.decode("utf-8", errors="replace")
        if isinstance(v, np.generic):
            return v.item()
    except Exception:  # noqa: BLE001
        pass
    try:
        # Try to coerce to a basic JSON type; fall back to str.
        json.dumps(v)
        return v
    except TypeError:
        return str(v)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("list", "preview"), required=True)
    parser.add_argument("--path", required=True)
    parser.add_argument("--dataset", default=None)
    parser.add_argument("--max-rows", type=int, default=200)
    args = parser.parse_args()

    if args.mode == "list":
        return list_datasets(args.path)
    if args.mode == "preview":
        if not args.dataset:
            return emit_err("--dataset is required in preview mode")
        return preview_dataset(args.path, args.dataset, args.max_rows)
    return emit_err(f"Unknown mode: {args.mode}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        sys.exit(emit_err(f"Uncaught exception: {e}", e))

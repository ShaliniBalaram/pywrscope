// src/components/ResultsViewer.tsx
// Reads Pywr result files (.csv or .h5/.hdf5) and previews them in a table.
//
// The component is a stateful modal: it asks the user for a path (via
// window.pywr.openResults()), introspects the file, and renders either:
//   - a CSV preview table (single dataset per file), or
//   - an HDF5 dataset picker followed by a preview table for the chosen one.
//
// Failure handling: every Tauri call returns an {ok, error?} envelope. We
// trust no exceptions — the bridge surfaces backend errors in-band so this
// component only needs one error rendering path.

import React, { useCallback, useEffect, useMemo, useState } from "react";

const PREVIEW_ROWS = 200;

interface CsvPreview {
  kind: "csv";
  path: string;
  headers: string[];
  rows: (string | number)[][];
  totalRows: number;
  returnedRows: number;
}

interface H5DatasetInfo {
  name: string;
  shape: number[];
  dtype: string;
  size: number;
}

interface H5Preview {
  kind: "h5";
  path: string;
  datasets: H5DatasetInfo[];
  selected: string | null;
  preview: {
    headers: string[];
    rows: (string | number)[][];
    totalRows: number;
    returnedRows: number;
    shape: number[];
  } | null;
}

// Error phase carries the failing path so the renderer can echo it back at the
// user. Without the path, "Could not read file" is a useless message — they
// just chose the file, so showing which one failed is the minimum context.
type ViewState =
  | { phase: "idle" }
  | { phase: "loading"; path: string }
  | { phase: "ready"; data: CsvPreview | H5Preview }
  | { phase: "error"; message: string; path: string | null };

// Heuristic — surface a one-line hint alongside the raw error so users have
// somewhere to look when the underlying message is opaque (e.g. h5py traceback).
// The hints are deliberately conservative: we only match strings the backend is
// known to produce, so we never lie about a cause.
function hintFor(message: string, path: string | null): string | null {
  const m = message.toLowerCase();
  if (m.includes("no such file") || m.includes("not found") || m.includes("could not read file")) {
    return "The file no longer exists at this path. It may have been moved or deleted.";
  }
  if (m.includes("file is empty")) {
    return "The CSV file has no rows. Pywr result CSVs start with a header row like 'date,scenario_0,…'.";
  }
  if (m.includes("h5py") && m.includes("not available")) {
    return "HDF5 support requires the bundled Python runtime. Run `npm run setup:python` and rebuild.";
  }
  if (m.includes("unable to open file") || m.includes("not an hdf5")) {
    return "The file isn't a valid HDF5 container. Check the extension matches the file format.";
  }
  if (m.includes("dataset") && m.includes("not found")) {
    return "Pick a different dataset from the list — the requested one isn't in this file.";
  }
  if (path && m.includes("unsupported file extension")) {
    return "Rename the file to .csv, .h5, or .hdf5 if it really is one of those formats.";
  }
  return null;
}

interface ResultsViewerProps {
  // Optional starting path — when set, opens directly without prompting.
  // Used by the run-complete handoff to jump straight into the results view.
  initialPath?: string | null;
  onClose: () => void;
}

export function ResultsViewer({ initialPath, onClose }: ResultsViewerProps) {
  const [view, setView] = useState<ViewState>({ phase: "idle" });

  // Format-dispatch: CSV vs HDF5. We branch on extension because both formats
  // need different backend calls (CSV is direct, HDF5 needs the python helper)
  // and produce different intermediate states (CSV → ready, HDF5 → dataset list
  // then ready after a pick).
  const loadFile = useCallback(async (path: string) => {
    setView({ phase: "loading", path });
    const lower = path.toLowerCase();
    if (lower.endsWith(".csv")) {
      const r = await window.pywr.readCsvPreview(path, PREVIEW_ROWS);
      if (!r.ok) {
        setView({ phase: "error", message: r.error ?? "Failed to read CSV", path });
        return;
      }
      setView({
        phase: "ready",
        data: {
          kind: "csv",
          path,
          headers: r.headers,
          rows: r.rows,
          totalRows: r.total_rows,
          returnedRows: r.returned_rows,
        },
      });
      return;
    }
    if (lower.endsWith(".h5") || lower.endsWith(".hdf5")) {
      const r = await window.pywr.readH5List(path);
      if (!r.ok) {
        setView({ phase: "error", message: r.error ?? "Failed to open HDF5", path });
        return;
      }
      const datasets = r.datasets ?? [];
      // Auto-pick when there's exactly one dataset — most Pywr H5 outputs have
      // one recorder series, so this skips a redundant click.
      if (datasets.length === 1) {
        const preview = await window.pywr.readH5Preview(path, datasets[0].name, PREVIEW_ROWS);
        if (!preview.ok) {
          setView({ phase: "error", message: preview.error ?? "Failed to preview dataset", path });
          return;
        }
        setView({
          phase: "ready",
          data: {
            kind: "h5",
            path,
            datasets,
            selected: datasets[0].name,
            preview: {
              headers: preview.headers ?? [],
              rows: preview.rows ?? [],
              totalRows: preview.total_rows ?? 0,
              returnedRows: preview.returned_rows ?? 0,
              shape: preview.shape ?? [],
            },
          },
        });
        return;
      }
      setView({
        phase: "ready",
        data: {
          kind: "h5",
          path,
          datasets,
          selected: null,
          preview: null,
        },
      });
      return;
    }
    setView({ phase: "error", message: `Unsupported file extension. Expected .csv, .h5, or .hdf5.`, path });
  }, []);

  // If the parent passes an initialPath, jump straight to it; otherwise the
  // user clicks Browse to pick.
  useEffect(() => {
    if (initialPath) {
      loadFile(initialPath);
    }
    // We only want this on first mount or when the explicit initial path
    // changes — re-loading on every render would defeat the modal pattern.
  }, [initialPath, loadFile]);

  const onBrowse = useCallback(async () => {
    const p = await window.pywr.openResults();
    if (!p) return;
    loadFile(p);
  }, [loadFile]);

  const onPickDataset = useCallback(async (name: string) => {
    if (view.phase !== "ready" || view.data.kind !== "h5") return;
    const path = view.data.path;
    setView({ phase: "loading", path });
    const preview = await window.pywr.readH5Preview(path, name, PREVIEW_ROWS);
    if (!preview.ok) {
      setView({ phase: "error", message: preview.error ?? "Failed to preview dataset", path });
      return;
    }
    // Re-fetch datasets is unnecessary — we already have them. Reuse the
    // earlier list to avoid a second python spawn.
    setView({
      phase: "ready",
      data: {
        kind: "h5",
        path,
        datasets: (view.data as H5Preview).datasets,
        selected: name,
        preview: {
          headers: preview.headers ?? [],
          rows: preview.rows ?? [],
          totalRows: preview.total_rows ?? 0,
          returnedRows: preview.returned_rows ?? 0,
          shape: preview.shape ?? [],
        },
      },
    });
  }, [view]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(15, 23, 42, 0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: "min(960px, 92vw)",
          maxHeight: "86vh",
          backgroundColor: "#f8fafc",
          borderRadius: 10,
          boxShadow: "0 24px 60px rgba(0,0,0,0.35)",
          display: "flex",
          flexDirection: "column",
          fontFamily: "sans-serif",
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          padding: "12px 18px", borderBottom: "1px solid #e2e8f0",
          backgroundColor: "#0f172a", color: "#f1f5f9",
        }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>Pywr Results Viewer</div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>
              CSV · HDF5 · .h5 · .hdf5
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: "transparent", border: "none", color: "#cbd5e1",
              cursor: "pointer", fontSize: 18, padding: 4,
            }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minHeight: 0 }}>
          {view.phase === "idle" && (
            <EmptyState onBrowse={onBrowse} />
          )}
          {view.phase === "loading" && (
            <Centered>
              <div style={{ color: "#475569", fontSize: 13 }}>
                Reading {view.path.split(/[\\/]/).pop()}…
              </div>
            </Centered>
          )}
          {view.phase === "error" && (
            <ErrorBody message={view.message} path={view.path} onBrowse={onBrowse} />
          )}
          {view.phase === "ready" && view.data.kind === "csv" && (
            <CsvBody data={view.data} onBrowse={onBrowse} />
          )}
          {view.phase === "ready" && view.data.kind === "h5" && (
            <H5Body data={view.data} onBrowse={onBrowse} onPickDataset={onPickDataset} />
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Subcomponents
// -----------------------------------------------------------------------------

function EmptyState({ onBrowse }: { onBrowse: () => void }) {
  return (
    <Centered>
      <div style={{ color: "#475569", fontSize: 13, marginBottom: 12 }}>
        Open a Pywr result file (CSV or HDF5) to preview its contents.
      </div>
      <button onClick={onBrowse} style={browseBtnStyle}>
        📂 Browse…
      </button>
      <FormatReference />
    </Centered>
  );
}

// Inline reference for the CSV shape the app expects. Shown on the idle
// (empty) screen and on errors so users always have a one-glance reminder
// of the accepted layout — no docs hunt needed.
function FormatReference() {
  return (
    <div
      style={{
        marginTop: 24,
        padding: 14,
        width: "min(640px, 90%)",
        backgroundColor: "#f1f5f9",
        border: "1px solid #cbd5e1",
        borderRadius: 8,
        fontSize: 12,
        color: "#334155",
        textAlign: "left",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 6, color: "#0f172a" }}>
        Accepted CSV layout
      </div>
      <div style={{ marginBottom: 6 }}>
        Pywr result CSVs (written by the bundled <code>run_pywr.py</code>) and any
        CSV with a leading date column will preview correctly. Header must be the
        first row.
      </div>
      <pre style={{
        margin: "6px 0 0 0",
        padding: 8,
        backgroundColor: "#0f172a",
        color: "#e2e8f0",
        fontSize: 11,
        borderRadius: 4,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        overflow: "auto",
      }}>
{`date,scenario_0,scenario_1
2024-01-01,5.20,4.81
2024-01-02,5.15,4.79
2024-01-03,5.18,4.85`}
      </pre>
      <div style={{ marginTop: 8, fontSize: 11, color: "#64748b" }}>
        For CSV-linked input parameters, the same shape works with a custom column name
        in place of <code>scenario_0</code>. See
        {" "}
        <code>examples/sample_results/recorder_example.csv</code>
        {" "}and{" "}
        <code>examples/sample_input/inflows_example.csv</code>
        {" "}in the repo.
      </div>
    </div>
  );
}

function ErrorBody({
  message,
  path,
  onBrowse,
}: {
  message: string;
  path: string | null;
  onBrowse: () => void;
}) {
  const hint = hintFor(message, path);
  const filename = path ? (path.split(/[\\/]/).pop() ?? path) : null;
  return (
    <div style={{ flex: 1, overflow: "auto", padding: 24, display: "flex", justifyContent: "center" }}>
      <div style={{ width: "min(640px, 100%)", display: "flex", flexDirection: "column", gap: 12 }}>
        {/* Error banner */}
        <div style={{
          display: "flex",
          gap: 12,
          padding: 14,
          borderRadius: 8,
          border: "1px solid #fecaca",
          backgroundColor: "#fef2f2",
          alignItems: "flex-start",
        }}>
          <div style={{ fontSize: 18, lineHeight: 1 }}>⚠️</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: "#991b1b", marginBottom: 4 }}>
              Couldn't open this file
            </div>
            {filename && (
              <div style={{
                fontSize: 11,
                color: "#7f1d1d",
                marginBottom: 8,
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                wordBreak: "break-all",
              }}>
                {filename}
                {path && path !== filename && (
                  <span style={{ color: "#a16060" }}> · {path}</span>
                )}
              </div>
            )}
            {hint && (
              <div style={{ fontSize: 12, color: "#7f1d1d", marginBottom: 8 }}>
                {hint}
              </div>
            )}
            <pre style={{
              margin: 0,
              padding: 8,
              backgroundColor: "#fff",
              border: "1px solid #fecaca",
              borderRadius: 4,
              fontSize: 11,
              color: "#7f1d1d",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 180,
              overflow: "auto",
            }}>
              {message}
            </pre>
          </div>
        </div>

        <div style={{ display: "flex", justifyContent: "center" }}>
          <button onClick={onBrowse} style={browseBtnStyle}>
            Choose another file
          </button>
        </div>

        <FormatReference />
      </div>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      flex: 1, display: "flex", flexDirection: "column",
      alignItems: "center", justifyContent: "center", gap: 10,
      padding: 24,
    }}>
      {children}
    </div>
  );
}

function CsvBody({ data, onBrowse }: { data: CsvPreview; onBrowse: () => void }) {
  return (
    <>
      <Subheader path={data.path} info={`CSV · ${data.returnedRows.toLocaleString()} of ${data.totalRows.toLocaleString()} rows`} onBrowse={onBrowse} />
      <DataTable headers={data.headers} rows={data.rows} />
    </>
  );
}

function H5Body({
  data,
  onBrowse,
  onPickDataset,
}: {
  data: H5Preview;
  onBrowse: () => void;
  onPickDataset: (name: string) => void;
}) {
  const [filter, setFilter] = useState("");
  const grouped = useMemo(() => groupH5Datasets(data.datasets, filter), [data.datasets, filter]);
  return (
    <>
      <Subheader
        path={data.path}
        info={`HDF5 · ${data.datasets.length} dataset(s)`}
        onBrowse={onBrowse}
      />
      <div style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Dataset picker */}
        <div style={{
          width: 240, flexShrink: 0,
          borderRight: "1px solid #e2e8f0",
          overflow: "auto",
          backgroundColor: "#f1f5f9",
        }}>
          <div style={{ padding: 10, borderBottom: "1px solid #e2e8f0", backgroundColor: "#fff" }}>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter layers"
              style={{
                width: "100%",
                boxSizing: "border-box",
                padding: "6px 8px",
                border: "1px solid #cbd5e1",
                borderRadius: 5,
                fontSize: 12,
              }}
            />
          </div>
          {data.datasets.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: "#64748b" }}>
              No datasets found.
            </div>
          )}
          {data.datasets.length > 0 && grouped.length === 0 && (
            <div style={{ padding: 12, fontSize: 12, color: "#64748b" }}>
              No matching layers.
            </div>
          )}
          {grouped.map((group) => (
            <div key={group.label}>
              <div style={{
                padding: "7px 10px",
                backgroundColor: "#e2e8f0",
                borderBottom: "1px solid #cbd5e1",
                fontSize: 10,
                fontWeight: 700,
                color: "#334155",
                textTransform: "uppercase",
                letterSpacing: 0,
              }}>
                {group.label} ({group.datasets.length})
              </div>
              {group.datasets.map((d) => {
                const sel = d.name === data.selected;
                const parts = d.name.split("/");
                const display = parts.slice(-2).join("/");
                return (
                  <button
                    key={d.name}
                    onClick={() => onPickDataset(d.name)}
                    title={d.name}
                    style={{
                      display: "block", width: "100%", textAlign: "left",
                      padding: "8px 12px",
                      background: sel ? "#dbeafe" : "transparent",
                      border: "none",
                      borderLeft: sel ? "3px solid #1d4ed8" : "3px solid transparent",
                      cursor: "pointer",
                      fontSize: 12, color: "#0f172a",
                      borderBottom: "1px solid #e2e8f0",
                    }}
                  >
                    <div style={{ fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {display}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {d.name}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b", marginTop: 2 }}>
                      shape [{d.shape.join(", ")}] · {d.dtype}
                    </div>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Preview pane */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {data.preview ? (
            <>
              <div style={{
                padding: "6px 14px", fontSize: 11, color: "#475569",
                borderBottom: "1px solid #e2e8f0", backgroundColor: "#fff",
              }}>
                {data.selected} · shape [{data.preview.shape.join(", ")}] · showing {data.preview.returnedRows.toLocaleString()} / {data.preview.totalRows.toLocaleString()} rows
              </div>
              <DataTable headers={data.preview.headers} rows={data.preview.rows} />
            </>
          ) : (
            <Centered>
              <div style={{ color: "#475569", fontSize: 13 }}>
                Pick a dataset on the left to preview.
              </div>
            </Centered>
          )}
        </div>
      </div>
    </>
  );
}

function groupH5Datasets(datasets: H5DatasetInfo[], filter: string): Array<{ label: string; datasets: H5DatasetInfo[] }> {
  const needle = filter.trim().toLowerCase();
  const groups = new Map<string, H5DatasetInfo[]>();
  for (const dataset of datasets) {
    if (needle && !dataset.name.toLowerCase().includes(needle)) continue;
    const parts = dataset.name.split("/");
    const label = parts.length >= 2 ? parts[0] : "root";
    const list = groups.get(label) ?? [];
    list.push(dataset);
    groups.set(label, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, groupDatasets]) => ({
      label,
      datasets: groupDatasets.sort((a, b) => a.name.localeCompare(b.name)),
    }));
}

function Subheader({ path, info, onBrowse }: { path: string; info: string; onBrowse: () => void }) {
  const filename = path.split(/[\\/]/).pop() ?? path;
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "8px 18px", borderBottom: "1px solid #e2e8f0",
      backgroundColor: "#fff",
    }}>
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 13, color: "#0f172a", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {filename}
        </div>
        <div style={{ fontSize: 11, color: "#64748b" }}>{info}</div>
      </div>
      <button onClick={onBrowse} style={browseBtnSmall}>📂 Browse…</button>
    </div>
  );
}

function DataTable({ headers, rows }: { headers: string[]; rows: (string | number)[][] }) {
  return (
    <div style={{ flex: 1, overflow: "auto", backgroundColor: "#fff" }}>
      <table style={{
        borderCollapse: "collapse",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
        minWidth: "100%",
      }}>
        <thead>
          <tr>
            {headers.map((h, i) => (
              <th
                key={i}
                style={{
                  padding: "6px 10px",
                  textAlign: "left",
                  borderBottom: "2px solid #cbd5e1",
                  position: "sticky", top: 0,
                  backgroundColor: "#f1f5f9",
                  color: "#0f172a",
                  fontWeight: 700,
                  whiteSpace: "nowrap",
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, ri) => (
            <tr key={ri} style={{ backgroundColor: ri % 2 ? "#f8fafc" : "#fff" }}>
              {row.map((cell, ci) => (
                <td
                  key={ci}
                  style={{
                    padding: "4px 10px",
                    borderBottom: "1px solid #e2e8f0",
                    color: "#1e293b",
                    whiteSpace: "nowrap",
                  }}
                >
                  {String(cell)}
                </td>
              ))}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={Math.max(1, headers.length)} style={{ padding: 16, color: "#64748b", textAlign: "center" }}>
                No rows.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

const browseBtnStyle: React.CSSProperties = {
  padding: "8px 18px",
  fontSize: 13,
  fontWeight: 600,
  borderRadius: 6,
  border: "none",
  cursor: "pointer",
  backgroundColor: "#1d4ed8",
  color: "#fff",
};

const browseBtnSmall: React.CSSProperties = {
  padding: "4px 10px",
  fontSize: 12,
  fontWeight: 600,
  borderRadius: 6,
  border: "1px solid #cbd5e1",
  cursor: "pointer",
  backgroundColor: "#fff",
  color: "#0f172a",
};

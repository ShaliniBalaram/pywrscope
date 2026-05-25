// src/components/ZeroFlowAnalyzer.tsx
// Whole-network zero-flow rank view (T1.3). For every node-bound recorder
// that produced a per-step CSV, count the timesteps whose cross-scenario mean
// is ~0, sort descending, and traffic-light by the spec thresholds
// (≥30 days = critical, ≥10 = warn).
//
// Why this exists: the per-node Results view answers "what happened at THIS
// node?", but it can't answer "which nodes are problematic across the whole
// model?". A real Pywr model can have hundreds of recorders — scanning each
// one in the downstream panel doesn't scale. The rank view turns that scan
// into a single sortable, filterable table.
//
// Common causes for high zero-flow counts (from the notebook DIAG patterns):
//   - orphan branches (node has no upstream supply path)
//   - infeasible licence caps (max_flow set below demand throughout)
//   - miswired costs (high-cost path never selected by the LP)
//
// Loading strategy: parallel readCsvPreview for every recorder with a CSV
// path. For a 365-timestep, 361-recorder run on the farnham_wrz5 example,
// every CSV is small (a few KB) and the IPC fans out cleanly. We don't
// pre-throttle — if a future model exposes a perf issue here, the
// readCsvPreview rust side is the right place to add streaming, not this
// component.
//
// Filter: recorders with fewer than 2 timesteps are excluded. They're almost
// always aggregate-style recorders (e.g. `*_deficit_frequency` writes a
// single-row CSV) where "zero-flow days" doesn't mean anything.

import React, { useEffect, useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import { isNodeBoundRecorder } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  computeStats,
  formatPct,
  severityForZeroDays,
  type RecorderStats,
  type ZeroFlowSeverity,
} from "../lib/recorderStats";

const MAX_ROWS = 200_000;
// Below this many timesteps the row is filtered out — see top-of-file note.
const MIN_TIMESTEPS_FOR_RANK = 2;

// One row in the analyzer's table — combines the model-side metadata (node
// name/type, recorder name/type, csv path) with the loaded stats.
export interface AnalyzerRow {
  nodeName: string;
  nodeType: string;
  recorderName: string;
  recorderType: string;
  csvPath: string;
  // null until loaded. After load: stats present, or error string present.
  stats: RecorderStats | null;
  error: string | null;
}

interface ZeroFlowAnalyzerProps {
  model: PywrModel;
  runState: RunStateView;
  // Click-through: jump back to the downstream view for the picked node.
  // Wired into the parent so selection stays in sync with the rest of the app.
  onSelectNode: (name: string) => void;
}

// Pure: from model + runState, build the list of (node, recorder, csvPath)
// candidates the analyzer should load. Exported so the test can pin the
// filtering rules without mocking React effects.
export function collectCandidates(
  model: PywrModel,
  runState: RunStateView,
): Omit<AnalyzerRow, "stats" | "error">[] {
  // recorder name → CSV path. Built first so the recorder loop is O(R) total.
  const csvByRecorder = new Map<string, string>();
  for (const o of runState.outputs) {
    if (o.name === "summary") continue;
    csvByRecorder.set(o.name, o.path);
  }

  // node name → type, for label-display.
  const nodeTypeByName = new Map<string, string>();
  for (const n of model.nodes) {
    nodeTypeByName.set(n.name, n.type);
  }

  const out: Omit<AnalyzerRow, "stats" | "error">[] = [];
  for (const [recName, rec] of Object.entries(model.recorders ?? {})) {
    if (!isNodeBoundRecorder(rec)) continue; // skip parameter / unknown recorders
    const csvPath = csvByRecorder.get(recName);
    if (!csvPath) continue; // aggregate-only recorder, no per-step file
    out.push({
      nodeName: rec.node,
      nodeType: nodeTypeByName.get(rec.node) ?? "?",
      recorderName: recName,
      recorderType: rec.type,
      csvPath,
    });
  }
  return out;
}

export function ZeroFlowAnalyzer({
  model,
  runState,
  onSelectNode,
}: ZeroFlowAnalyzerProps) {
  const candidates = useMemo(
    () => collectCandidates(model, runState),
    [model, runState],
  );

  const [rows, setRows] = useState<AnalyzerRow[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

  // Stable key: a new run produces new CSV paths, so the paths themselves form
  // the cache key. Same scheme as NodeTimeSeriesChart.
  const cacheKey = useMemo(
    () => candidates.map((c) => `${c.recorderName}|${c.csvPath}`).join("\n"),
    [candidates],
  );

  useEffect(() => {
    if (candidates.length === 0) {
      setRows([]);
      setLoadedCount(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadedCount(0);
    // Seed the table with metadata-only rows so the user can see "what is
    // being analysed" while the CSV reads are in flight. Stats fill in as
    // each read completes.
    const seed: AnalyzerRow[] = candidates.map((c) => ({
      ...c,
      stats: null,
      error: null,
    }));
    setRows(seed);

    // Parallel load — Promise.allSettled because one bad CSV shouldn't
    // poison the rest of the table. Each completion bumps loadedCount for
    // the progress readout.
    (async () => {
      const work = candidates.map(async (c, idx) => {
        try {
          const res = await window.pywr.readCsvPreview(c.csvPath, MAX_ROWS);
          if (cancelled) return;
          if (!res.ok) {
            setRows((prev) => updateRow(prev, idx, {
              error: res.error ?? "Could not read CSV",
            }));
            return;
          }
          const parsed = parseCsvSeries(
            c.recorderName,
            c.recorderType,
            res.headers,
            res.rows,
          );
          if (parsed.error || !parsed.series) {
            setRows((prev) => updateRow(prev, idx, {
              error: parsed.error ?? "Empty series",
            }));
            return;
          }
          const stats = computeStats(parsed.series.values, parsed.series.dates);
          setRows((prev) => updateRow(prev, idx, { stats }));
        } catch (e) {
          if (cancelled) return;
          setRows((prev) => updateRow(prev, idx, {
            error: e instanceof Error ? e.message : String(e),
          }));
        } finally {
          if (!cancelled) setLoadedCount((n) => n + 1);
        }
      });
      await Promise.allSettled(work);
      if (!cancelled) setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Sort + filter. Done in render rather than in state so the user-visible
  // ordering is always derived from the current rows + filter — no
  // synchronisation bugs between "stored sort" and "current data".
  const displayRows = useMemo(() => {
    const filtered = filter.trim()
      ? rows.filter((r) =>
          r.nodeName.toLowerCase().includes(filter.toLowerCase()) ||
          r.recorderName.toLowerCase().includes(filter.toLowerCase()),
        )
      : rows;
    // Rows still loading (no stats, no error) are pushed to the bottom so the
    // critical-severity rows surface immediately as their reads finish. Among
    // loaded rows, sort by zeroDays desc; tiebreak by % active asc (worse
    // first) and finally by node name for determinism.
    return [...filtered].sort((a, b) => {
      const aLoaded = a.stats !== null;
      const bLoaded = b.stats !== null;
      if (aLoaded !== bLoaded) return aLoaded ? -1 : 1;
      if (a.stats && b.stats) {
        const dz = b.stats.zeroDays - a.stats.zeroDays;
        if (dz !== 0) return dz;
        const da = (a.stats.pctActive || 0) - (b.stats.pctActive || 0);
        if (da !== 0) return da;
      }
      return a.nodeName.localeCompare(b.nodeName);
    });
  }, [rows, filter]);

  // Recorders with too few timesteps are dropped from the visible rank — see
  // top-of-file note. They still appear in the candidate count so the
  // "showing N of M" line stays honest about what was filtered.
  const visibleRows = useMemo(
    () => displayRows.filter((r) =>
      r.stats === null || r.stats.totalDays >= MIN_TIMESTEPS_FOR_RANK,
    ),
    [displayRows],
  );

  // Severity tallies — only counted on rows with stats so loading rows don't
  // contribute false "ok" counts.
  const tally = useMemo(() => {
    const t = { critical: 0, warn: 0, ok: 0, errors: 0 };
    for (const r of visibleRows) {
      if (r.error) { t.errors++; continue; }
      if (!r.stats) continue;
      t[severityForZeroDays(r.stats.zeroDays)]++;
    }
    return t;
  }, [visibleRows]);

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        No node-bound recorders with per-step CSV output found in the last run.
        Add a <code>NumpyArrayNodeRecorder</code> (or storage variant) to one
        or more nodes, then re-run the model.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={headerStyle}>
        <div style={titleStyle}>Zero-flow rank</div>
        <div style={subtitleStyle}>
          {visibleRows.length} of {candidates.length} recorders
          {loading && ` · loaded ${loadedCount}/${candidates.length}`}
        </div>
        <div style={tallyStyle}>
          <SeverityChip severity="critical" count={tally.critical} />
          <SeverityChip severity="warn" count={tally.warn} />
          <SeverityChip severity="ok" count={tally.ok} />
          {tally.errors > 0 && (
            <div style={{ ...chipStyle, color: "#991b1b", borderColor: "#fecaca", background: "#fef2f2" }}>
              {tally.errors} error{tally.errors === 1 ? "" : "s"}
            </div>
          )}
        </div>
        <input
          type="text"
          placeholder="Filter by node or recorder name…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={filterInputStyle}
          aria-label="Filter zero-flow rows"
        />
      </div>

      <div style={tableScrollStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Severity</th>
              <th style={thStyle}>Node</th>
              <th style={thStyle}>Recorder</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Zero days</th>
              <th style={{ ...thStyle, textAlign: "right" }}>% active</th>
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((r) => (
              <AnalyzerTableRow
                key={`${r.nodeName}|${r.recorderName}`}
                row={r}
                onSelect={() => onSelectNode(r.nodeName)}
              />
            ))}
            {visibleRows.length === 0 && (
              <tr>
                <td colSpan={5} style={{ padding: 18, textAlign: "center", color: "#64748b", fontSize: 12 }}>
                  No rows match the current filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AnalyzerTableRow({
  row,
  onSelect,
}: { row: AnalyzerRow; onSelect: () => void }) {
  const severity: ZeroFlowSeverity =
    row.stats ? severityForZeroDays(row.stats.zeroDays) : "ok";
  const color = SEVERITY_COLOR[severity];
  const zeroLabel = row.error
    ? "—"
    : row.stats
      ? `${row.stats.zeroDays.toLocaleString()} / ${row.stats.totalDays.toLocaleString()}`
      : "…";
  const activeLabel = row.error
    ? "error"
    : row.stats
      ? formatPct(row.stats.pctActive)
      : "…";
  return (
    <tr
      onClick={onSelect}
      style={trStyle}
      title={
        row.error
          ? `Could not read CSV: ${row.error}`
          : `Click to view ${row.nodeName} in the Downstream panel`
      }
    >
      <td style={tdStyle}>
        <span
          style={{
            display: "inline-block",
            width: 10, height: 10, borderRadius: 5,
            background: row.error ? "#94a3b8" : color,
            boxShadow: severity === "critical" && !row.error
              ? "0 0 0 3px rgba(220,38,38,0.18)"
              : "none",
          }}
        />
      </td>
      <td style={tdStyle}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{row.nodeName}</div>
        <div style={{ fontSize: 10, color: "#64748b" }}>{row.nodeType}</div>
      </td>
      <td style={tdStyle}>
        <div style={{ fontSize: 11, color: "#334155", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
          {row.recorderName}
        </div>
        <div style={{ fontSize: 10, color: "#64748b" }}>{row.recorderType}</div>
      </td>
      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: row.error ? "#991b1b" : color, fontWeight: 600 }}>
        {zeroLabel}
      </td>
      <td style={{ ...tdStyle, textAlign: "right", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", color: row.error ? "#991b1b" : "#0f172a" }}>
        {activeLabel}
      </td>
    </tr>
  );
}

function SeverityChip({ severity, count }: { severity: ZeroFlowSeverity; count: number }) {
  const color = SEVERITY_COLOR[severity];
  return (
    <div
      style={{
        ...chipStyle,
        color,
        borderColor: `${color}55`,
        background: `${color}11`,
      }}
      title={SEVERITY_LABEL[severity]}
    >
      <span style={{
        width: 8, height: 8, borderRadius: 4, background: color, display: "inline-block", marginRight: 6,
      }} />
      {count} {SEVERITY_LABEL[severity]}
    </div>
  );
}

// In-place row update — avoids rewriting the whole array when one read
// completes. The caller treats the returned array as a fresh value so React
// re-renders. (Mutating in place would break that.)
function updateRow(
  prev: AnalyzerRow[],
  idx: number,
  patch: Partial<AnalyzerRow>,
): AnalyzerRow[] {
  if (idx < 0 || idx >= prev.length) return prev;
  const next = prev.slice();
  next[idx] = { ...prev[idx], ...patch };
  return next;
}

// ---------------------------------------------------------------------------
// Styles & constants
// ---------------------------------------------------------------------------

const SEVERITY_COLOR: Record<ZeroFlowSeverity, string> = {
  critical: "#dc2626", // red-600
  warn: "#d97706",     // amber-600 / orange
  ok: "#059669",       // emerald-600
};

const SEVERITY_LABEL: Record<ZeroFlowSeverity, string> = {
  critical: "critical",
  warn: "warn",
  ok: "ok",
};

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const tallyStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  padding: "3px 10px",
  borderRadius: 12,
  border: "1px solid",
  fontSize: 11,
  fontWeight: 600,
};

const filterInputStyle: React.CSSProperties = {
  padding: "6px 10px",
  fontSize: 12,
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  outline: "none",
  fontFamily: "inherit",
};

const tableScrollStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  background: "#f8fafc",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#fff",
};

const thStyle: React.CSSProperties = {
  position: "sticky",
  top: 0,
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 10,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "8px 12px",
  textAlign: "left",
  zIndex: 1,
};

const trStyle: React.CSSProperties = {
  cursor: "pointer",
  borderBottom: "1px solid #f1f5f9",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "top",
  fontSize: 12,
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: 13,
  padding: 24,
  textAlign: "center",
};

// Exported for unit tests.
export const _internal = { collectCandidates, MIN_TIMESTEPS_FOR_RANK };

// src/components/ReliabilityDashboard.tsx
// T2.7 reliability league table.
//
// For every Output node with a numeric `max_flow` (interpreted as a fixed
// demand), compute:
//   - deficit days       — timesteps where supply < demand (within 1%)
//   - reliability %      — share of timesteps that met demand
//   - longest deficit run — consecutive failure streak (drought signature)
//   - total shortfall    — sum (demand - supply) across deficit days
//
// Sorted worst → best by reliability %. Replicates notebook DIAG-5 / N-2 /
// N-3 (the deficit / reliability sweep) — the question this view answers is
// "which demand points are not being met, and by how much?"
//
// Outputs whose max_flow is a parameter reference (string) appear in a
// separate "parameter-driven" section because we can't resolve the demand
// without evaluating Pywr parameters over time — that's T3 territory.
// Unconstrained outputs are hidden entirely; reliability isn't meaningful
// when there's no demand to fall short of.

import React, { useEffect, useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import { isNodeBoundRecorder } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import { normalizeNodeType } from "../constants/nodeTypes";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  computeReliability,
  extractDemand,
  formatReliability,
  severityForReliability,
  type ReliabilitySeverity,
  type ReliabilityStats,
  type DemandKind,
} from "../lib/reliability";
import { formatVolume } from "../lib/massBalance";

const MAX_ROWS = 200_000;

interface DashboardRow {
  nodeName: string;
  recorderName: string;
  recorderType: string;
  csvPath: string;
  demandKind: DemandKind;
  demand: number; // NaN for non-numeric kinds
  paramName: string;
  stats: ReliabilityStats | null;
  error: string | null;
}

interface ReliabilityDashboardProps {
  model: PywrModel;
  runState: RunStateView;
  onSelectNode: (name: string) => void;
}

// Pure: build the loader list. Returns one row per Output node + its primary
// node-bound recorder. If an Output has multiple recorders we prefer one of
// type NumpyArrayNodeRecorder so the reliability is computed from the flow
// stream (rather than e.g. deficit). Exported for unit tests.
export function collectReliabilityCandidates(
  model: PywrModel,
  runState: RunStateView,
): Omit<DashboardRow, "stats" | "error">[] {
  // recorder name → csv path
  const csvByRecorder = new Map<string, string>();
  for (const o of runState.outputs) {
    if (o.name === "summary") continue;
    csvByRecorder.set(o.name, o.path);
  }

  // node name → list of (recorder, type, csvPath)
  const recordersByNode = new Map<
    string,
    { name: string; type: string; csvPath: string }[]
  >();
  for (const [recName, rec] of Object.entries(model.recorders ?? {})) {
    if (!isNodeBoundRecorder(rec)) continue;
    const csvPath = csvByRecorder.get(recName);
    if (!csvPath) continue;
    const list = recordersByNode.get(rec.node) ?? [];
    list.push({
      name: recName,
      type: rec.type,
      csvPath,
    });
    recordersByNode.set(rec.node, list);
  }

  const out: Omit<DashboardRow, "stats" | "error">[] = [];
  for (const n of model.nodes) {
    if (normalizeNodeType(n.type) !== "Output") continue;
    const recs = recordersByNode.get(n.name);
    if (!recs || recs.length === 0) continue;
    // Prefer the plain flow recorder when more than one is attached. Fallback
    // is "first non-deficit recorder", then "first recorder".
    const flow = recs.find((r) => r.type === "NumpyArrayNodeRecorder")
      ?? recs.find((r) => !/Deficit/i.test(r.type))
      ?? recs[0];

    // Use a typed bag-accessor for the optional max_flow field — PywrNode is
    // a discriminated union and not every variant exposes it at compile time.
    const fields = n as unknown as Record<string, unknown>;
    const demand = extractDemand(fields.max_flow);
    if (demand.kind === "unconstrained") continue;

    out.push({
      nodeName: n.name,
      recorderName: flow.name,
      recorderType: flow.type,
      csvPath: flow.csvPath,
      demandKind: demand.kind,
      demand: demand.value,
      paramName: demand.paramName,
    });
  }
  return out;
}

export function ReliabilityDashboard({
  model,
  runState,
  onSelectNode,
}: ReliabilityDashboardProps) {
  const candidates = useMemo(
    () => collectReliabilityCandidates(model, runState),
    [model, runState],
  );

  const [rows, setRows] = useState<DashboardRow[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("");

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
    const seed: DashboardRow[] = candidates.map((c) => ({
      ...c,
      stats: null,
      error: null,
    }));
    setRows(seed);

    (async () => {
      const work = candidates.map(async (c, idx) => {
        try {
          // Parameter-driven rows can't be evaluated for reliability — short-
          // circuit so we don't waste the read.
          if (c.demandKind !== "numeric") {
            setLoadedCount((n) => n + 1);
            return;
          }
          const res = await window.pywr.readCsvPreview(c.csvPath, MAX_ROWS);
          if (cancelled) return;
          if (!res.ok) {
            setRows((prev) => updateRow(prev, idx, {
              error: res.error ?? "Could not read CSV",
            }));
            return;
          }
          const parsed = parseCsvSeries(c.recorderName, c.recorderType, res.headers, res.rows);
          if (parsed.error || !parsed.series) {
            setRows((prev) => updateRow(prev, idx, {
              error: parsed.error ?? "Empty series",
            }));
            return;
          }
          const stats = computeReliability(parsed.series.values, c.demand);
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

  // Split into numeric (rankable) and parameter (visible but not ranked).
  const numericRows = useMemo(
    () => rows.filter((r) => r.demandKind === "numeric"),
    [rows],
  );
  const parameterRows = useMemo(
    () => rows.filter((r) => r.demandKind === "parameter"),
    [rows],
  );

  // Sort worst → best by reliability. Unloaded rows (stats === null) bubble
  // to the bottom so the user sees critical results immediately as reads
  // complete. Errors sort with reliability = -∞ so they surface at the top
  // for fixing.
  const visibleNumeric = useMemo(() => {
    const filtered = filter.trim()
      ? numericRows.filter((r) =>
          r.nodeName.toLowerCase().includes(filter.toLowerCase()) ||
          r.recorderName.toLowerCase().includes(filter.toLowerCase()))
      : numericRows;
    return [...filtered].sort((a, b) => {
      // Errors first.
      if (a.error && !b.error) return -1;
      if (!a.error && b.error) return 1;
      const aLoaded = a.stats !== null;
      const bLoaded = b.stats !== null;
      if (aLoaded !== bLoaded) return aLoaded ? -1 : 1;
      if (a.stats && b.stats) {
        // Worst reliability first. NaN reliability sorts last among loaded.
        const ar = Number.isFinite(a.stats.pctReliability) ? a.stats.pctReliability : Infinity;
        const br = Number.isFinite(b.stats.pctReliability) ? b.stats.pctReliability : Infinity;
        return ar - br;
      }
      return a.nodeName.localeCompare(b.nodeName);
    });
  }, [numericRows, filter]);

  // Tally chips: count by severity. Same idiom as ZeroFlowAnalyzer.
  const tally = useMemo(() => {
    const t = { critical: 0, warn: 0, ok: 0, errors: 0 };
    for (const r of visibleNumeric) {
      if (r.error) { t.errors++; continue; }
      if (!r.stats) continue;
      t[severityForReliability(r.stats.pctReliability)]++;
    }
    return t;
  }, [visibleNumeric]);

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        No Output nodes with a demand (numeric or parameter <code>max_flow</code>)
        and a node-bound recorder were found. Reliability needs both. Add a
        <code> max_flow</code> + <code>NumpyArrayNodeRecorder</code> to your
        demand nodes, then re-run the model.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={headerStyle}>
        <div style={titleStyle}>Reliability dashboard</div>
        <div style={subtitleStyle}>
          {visibleNumeric.length} numeric-demand output{visibleNumeric.length === 1 ? "" : "s"}
          {parameterRows.length > 0 && ` · ${parameterRows.length} parameter-driven`}
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
          aria-label="Filter reliability rows"
        />
      </div>

      <div style={tableScrollStyle}>
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Severity</th>
              <th style={thStyle}>Node</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Demand</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Reliability</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Deficit days</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Longest run</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Total shortfall</th>
            </tr>
          </thead>
          <tbody>
            {visibleNumeric.map((r) => (
              <NumericRow
                key={`${r.nodeName}|${r.recorderName}`}
                row={r}
                onSelect={() => onSelectNode(r.nodeName)}
              />
            ))}
            {visibleNumeric.length === 0 && (
              <tr><td colSpan={7} style={emptyCellStyle}>No rows match the current filter.</td></tr>
            )}
          </tbody>
        </table>

        {parameterRows.length > 0 && (
          <div style={paramSectionStyle}>
            <div style={paramTitleStyle}>
              Parameter-driven demands ({parameterRows.length})
            </div>
            <div style={paramHintStyle}>
              These outputs have <code>max_flow</code> set to a parameter
              reference. Reliability can't be computed without evaluating the
              parameter over time. Click a row to inspect its time series.
            </div>
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Node</th>
                  <th style={thStyle}>Parameter</th>
                  <th style={thStyle}>Recorder</th>
                </tr>
              </thead>
              <tbody>
                {parameterRows.map((r) => (
                  <tr
                    key={`${r.nodeName}|${r.recorderName}`}
                    onClick={() => onSelectNode(r.nodeName)}
                    style={trStyle}
                  >
                    <td style={tdStyle}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{r.nodeName}</div>
                    </td>
                    <td style={tdMonoStyle}>{r.paramName}</td>
                    <td style={tdMonoStyle}>{r.recorderName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function NumericRow({
  row,
  onSelect,
}: { row: DashboardRow; onSelect: () => void }) {
  const severity: ReliabilitySeverity =
    row.stats ? severityForReliability(row.stats.pctReliability) : "ok";
  const color = SEVERITY_COLOR[severity];
  const stats = row.stats;
  return (
    <tr
      onClick={onSelect}
      style={trStyle}
      title={
        row.error
          ? `Could not read CSV: ${row.error}`
          : `Click to inspect ${row.nodeName} in the Downstream panel`
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
        <div style={{ fontSize: 10, color: "#64748b" }}>{row.recorderName}</div>
      </td>
      <td style={tdMonoStyle}>{formatVolume(row.demand)}</td>
      <td style={{ ...tdMonoStyle, color: row.error ? "#991b1b" : color, fontWeight: 600 }}>
        {row.error ? "error" : stats ? formatReliability(stats.pctReliability) : "…"}
      </td>
      <td style={tdMonoStyle}>
        {row.error ? "—" : stats ? `${stats.deficitDays.toLocaleString()} / ${stats.totalDays.toLocaleString()}` : "…"}
      </td>
      <td style={tdMonoStyle}>
        {row.error ? "—" : stats ? stats.longestDeficitRun.toLocaleString() : "…"}
      </td>
      <td style={tdMonoStyle}>
        {row.error ? "—" : stats ? formatVolume(stats.totalShortfall) : "…"}
      </td>
    </tr>
  );
}

function SeverityChip({ severity, count }: { severity: ReliabilitySeverity; count: number }) {
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

function updateRow(
  prev: DashboardRow[],
  idx: number,
  patch: Partial<DashboardRow>,
): DashboardRow[] {
  if (idx < 0 || idx >= prev.length) return prev;
  const next = prev.slice();
  next[idx] = { ...prev[idx], ...patch };
  return next;
}

// ---------------------------------------------------------------------------
// Styles & constants
// ---------------------------------------------------------------------------

const SEVERITY_COLOR: Record<ReliabilitySeverity, string> = {
  critical: "#dc2626",
  warn: "#d97706",
  ok: "#059669",
};

const SEVERITY_LABEL: Record<ReliabilitySeverity, string> = {
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
  fontSize: 14, fontWeight: 700, color: "#0f172a",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b",
};

const tallyStyle: React.CSSProperties = {
  display: "flex", gap: 8, flexWrap: "wrap",
};

const chipStyle: React.CSSProperties = {
  display: "inline-flex", alignItems: "center",
  padding: "3px 10px", borderRadius: 12, border: "1px solid",
  fontSize: 11, fontWeight: 600,
};

const filterInputStyle: React.CSSProperties = {
  padding: "6px 10px", fontSize: 12,
  border: "1px solid #e2e8f0", borderRadius: 6, outline: "none",
  fontFamily: "inherit",
};

const tableScrollStyle: React.CSSProperties = {
  flex: 1, overflow: "auto", background: "#f8fafc",
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse", background: "#fff",
};

const thStyle: React.CSSProperties = {
  position: "sticky", top: 0, background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 10, fontWeight: 700, color: "#64748b",
  textTransform: "uppercase", letterSpacing: 0.5,
  padding: "8px 12px", textAlign: "left", zIndex: 1,
};

const trStyle: React.CSSProperties = {
  cursor: "pointer", borderBottom: "1px solid #f1f5f9",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px", verticalAlign: "top", fontSize: 12,
};

const tdMonoStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#0f172a",
};

const paramSectionStyle: React.CSSProperties = {
  marginTop: 16, padding: "12px 16px", background: "#fff",
  borderTop: "1px solid #e2e8f0",
};

const paramTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#475569",
  textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 4,
};

const paramHintStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b", marginBottom: 8, lineHeight: 1.4,
};

const emptyCellStyle: React.CSSProperties = {
  padding: 18, textAlign: "center", color: "#64748b", fontSize: 12,
};

const emptyStyle: React.CSSProperties = {
  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
  color: "#64748b", fontSize: 13, padding: 24, textAlign: "center",
};

// Exported for unit tests.
export const _internal = { collectReliabilityCandidates };

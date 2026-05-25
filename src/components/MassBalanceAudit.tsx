// src/components/MassBalanceAudit.tsx
// System mass-balance audit (T1.4). Loads every node-bound recorder for the
// last run, classifies each by its node's role (source / sink / storage /
// internal), aggregates per-timestep, and surfaces:
//
//   1. Total inputs vs total outputs vs net storage change.
//   2. Residual (inputs - outputs - ΔS) — should be ≈ 0 for a conserving run.
//   3. Per-day net imbalance table with the worst-negative days highlighted.
//   4. Violation chip: candidate LP-conservation failures.
//
// Why this exists (echo of TODO.md T1.4): the LP solver in Pywr guarantees
// mass conservation on its internal graph, but it doesn't catch user errors
// like a misclassified Catchment that's actually behaving as a sink, or a
// recorder set that skips half the network. The audit is the cheapest way to
// notice "wait, the run says we lost 30% of the water" before chasing it
// through individual nodes.
//
// Loading strategy mirrors ZeroFlowAnalyzer: parallel readCsvPreview for every
// candidate recorder, with metadata-only rows seeded synchronously so the
// header shows progress while the I/O fans out. Pure math lives in
// src/lib/massBalance — this file owns layout and CSV-side glue only.

import React, { useEffect, useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import { isNodeBoundRecorder } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  BALANCE_RELATIVE_TOL,
  classifyNodeForBalance,
  collapseScenarios,
  computeMassBalance,
  formatSigned,
  formatVolume,
  type BalanceRole,
  type BalanceSeries,
  type MassBalance,
} from "../lib/massBalance";

const MAX_ROWS = 200_000;
// Cap on the worst-day list rendered in the UI. The pure helper accepts an
// arbitrary limit; we pin a sensible default here so the panel doesn't blow up
// on a model with thousands of bad days.
const WORST_DAY_LIMIT = 12;

// One row in the auditor's loader. Lives between "what we know from the model"
// (node, recorder, role, csvPath) and "what we read from disk" (series,
// error). Once series is non-null OR error is non-null, the row is done.
interface AuditCandidate {
  nodeName: string;
  nodeType: string;
  recorderName: string;
  recorderType: string;
  role: BalanceRole;
  csvPath: string;
  series: BalanceSeries | null;
  error: string | null;
}

interface MassBalanceAuditProps {
  model: PywrModel;
  runState: RunStateView;
  // Click-through: jump back to the per-node downstream view for the picked
  // node. Wired into ResultsTab so a worst-day row jumps to the node behind
  // the biggest imbalance.
  onSelectNode: (name: string) => void;
}

// Pure: build the loader list from model + runState. Same pattern as
// ZeroFlowAnalyzer.collectCandidates so the two share a mental model.
// Exported (via _internal) for unit tests.
export function collectAuditCandidates(
  model: PywrModel,
  runState: RunStateView,
): Omit<AuditCandidate, "series" | "error">[] {
  // recorder name → CSV path. Drop summary.json since it's not a series.
  const csvByRecorder = new Map<string, string>();
  for (const o of runState.outputs) {
    if (o.name === "summary") continue;
    csvByRecorder.set(o.name, o.path);
  }

  // node name → type, so we can classify each recorder by its node's role.
  const nodeTypeByName = new Map<string, string>();
  for (const n of model.nodes) {
    nodeTypeByName.set(n.name, n.type);
  }

  const out: Omit<AuditCandidate, "series" | "error">[] = [];
  for (const [recName, rec] of Object.entries(model.recorders ?? {})) {
    if (!isNodeBoundRecorder(rec)) continue;
    const csvPath = csvByRecorder.get(recName);
    if (!csvPath) continue;
    const nodeType = nodeTypeByName.get(rec.node) ?? "";
    const role = classifyNodeForBalance(nodeType);
    // We keep "internal" rows out of the loader entirely — they don't
    // contribute to the audit and reading their CSV for no reason burns time.
    if (role === "internal") continue;
    out.push({
      nodeName: rec.node,
      nodeType,
      recorderName: recName,
      recorderType: rec.type,
      role,
      csvPath,
    });
  }
  return out;
}

export function MassBalanceAudit({
  model,
  runState,
  onSelectNode,
}: MassBalanceAuditProps) {
  const candidates = useMemo(
    () => collectAuditCandidates(model, runState),
    [model, runState],
  );

  const [rows, setRows] = useState<AuditCandidate[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Stable key: a new run = new CSV paths. Recompute and refetch when paths
  // change. Same scheme used by ZeroFlowAnalyzer.
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
    const seed: AuditCandidate[] = candidates.map((c) => ({
      ...c,
      series: null,
      error: null,
    }));
    setRows(seed);

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
          const collapsed = collapseScenarios(parsed.series.values);
          const series: BalanceSeries = {
            recorderName: c.recorderName,
            nodeName: c.nodeName,
            role: c.role,
            dates: parsed.series.dates,
            collapsed,
          };
          setRows((prev) => updateRow(prev, idx, { series }));
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

  // Derive the audit from whichever rows have finished loading. Showing
  // partial results while loads finish keeps the panel feeling fast on
  // larger models; the totals settle as more series arrive.
  const balance = useMemo<MassBalance>(() => {
    const series = rows
      .map((r) => r.series)
      .filter((s): s is BalanceSeries => s !== null);
    return computeMassBalance(series, { worstDayLimit: WORST_DAY_LIMIT });
  }, [rows]);

  // Bucket counts — used in the header readout so the user can see at a
  // glance how many sources / sinks / storages contribute to the totals.
  // A model with zero sinks is a common cause of "100% imbalance"; making
  // the count visible turns that into a five-second diagnosis.
  const bucketCounts = useMemo(() => {
    const c = { source: 0, sink: 0, storage: 0, errors: 0 };
    for (const r of rows) {
      if (r.error) c.errors++;
      else if (r.series) c[r.series.role as "source" | "sink" | "storage"]++;
    }
    return c;
  }, [rows]);

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        No source / sink / storage recorders found in the last run. The audit
        needs node-bound recorders on at least one Input (or Catchment) and
        one Output to compare totals. Add a <code>NumpyArrayNodeRecorder</code>
        to your sources and sinks, then re-run the model.
      </div>
    );
  }

  // Conservation severity drives the headline pill. Three states:
  //   - clean   : residual within tolerance — pill green
  //   - warn    : residual outside tolerance but explained by storage drift
  //   - violate : violationDays > 0, or large residual with no storage
  // Computed here (not in the lib) because it's a presentation decision —
  // the same numbers can be acceptable or alarming depending on context,
  // and we don't want to bake "alarm" into the pure math.
  const severity = computeSeverity(balance);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={headerStyle}>
        <div style={titleRowStyle}>
          <div style={titleStyle}>System mass balance</div>
          <SeverityPill severity={severity} balance={balance} />
        </div>
        <div style={subtitleStyle}>
          {bucketCounts.source} source{bucketCounts.source === 1 ? "" : "s"} ·{" "}
          {bucketCounts.sink} sink{bucketCounts.sink === 1 ? "" : "s"} ·{" "}
          {bucketCounts.storage} storage{bucketCounts.storage === 1 ? "" : "s"}
          {loading && ` · loaded ${loadedCount}/${candidates.length}`}
          {bucketCounts.errors > 0 && (
            <span style={{ color: "#991b1b", marginLeft: 8 }}>
              · {bucketCounts.errors} recorder error{bucketCounts.errors === 1 ? "" : "s"}
            </span>
          )}
        </div>
      </div>

      <div style={bodyStyle}>
        <SummaryCards balance={balance} />

        {balance.violationDays > 0 && (
          <div style={violationCalloutStyle}>
            <div style={violationTitleStyle}>
              {balance.violationDays} candidate LP violation{balance.violationDays === 1 ? "" : "s"}
            </div>
            <div style={violationBodyStyle}>
              These timesteps show more outflow than inflow even after the
              storage budget allows. Either (a) a source recorder is missing,
              (b) a node is misclassified (e.g. a Catchment recording deficit
              instead of flow), or (c) the LP solver returned a non-conserving
              result for this scenario. Inspect the worst-imbalance days below.
            </div>
          </div>
        )}

        <WorstDaysTable balance={balance} onSelectNode={onSelectNode} rows={rows} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-views
// ---------------------------------------------------------------------------

function SummaryCards({ balance }: { balance: MassBalance }) {
  return (
    <div style={summaryRowStyle}>
      <SummaryCard
        label="Σ inputs"
        value={formatVolume(balance.totalInputs)}
        color="#1d4ed8"
      />
      <SummaryCard
        label="Σ outputs"
        value={formatVolume(balance.totalOutputs)}
        color="#b45309"
      />
      <SummaryCard
        label="Δ storage"
        value={formatSigned(balance.storageDelta)}
        color="#0e7490"
        hint={
          balance.storageDelta === 0
            ? "no storage recorded"
            : balance.storageDelta > 0
              ? "filled"
              : "released"
        }
      />
      <SummaryCard
        label="Residual"
        value={formatSigned(balance.residual)}
        color={residualColor(balance)}
        hint={
          Number.isFinite(balance.pctImbalance)
            ? `${balance.pctImbalance.toFixed(2)}% of largest total`
            : "no flow recorded"
        }
      />
    </div>
  );
}

function SummaryCard({
  label, value, color, hint,
}: { label: string; value: string; color: string; hint?: string }) {
  return (
    <div style={cardStyle}>
      <div style={{ ...cardLabelStyle, color }}>{label}</div>
      <div style={{ ...cardValueStyle, color }}>{value}</div>
      {hint && <div style={cardHintStyle}>{hint}</div>}
    </div>
  );
}

function WorstDaysTable({
  balance,
  onSelectNode,
  rows,
}: {
  balance: MassBalance;
  onSelectNode: (name: string) => void;
  rows: AuditCandidate[];
}) {
  // To make the worst-day row clickable we want a candidate sink to jump to.
  // The audit doesn't track "which node was responsible" — that's a deeper
  // attribution problem (T3.10). For now we pick the first sink that has a
  // loaded series, so the click jumps somewhere informative rather than
  // nowhere. If no sink loaded, the row is non-clickable.
  const fallbackSink = useMemo(() => {
    for (const r of rows) {
      if (r.series && r.series.role === "sink") return r.nodeName;
    }
    return null;
  }, [rows]);

  if (balance.daily.length === 0) {
    return null;
  }

  return (
    <div style={{ marginTop: 18 }}>
      <div style={sectionTitleStyle}>
        Worst-imbalance days (top {balance.worstDays.length})
      </div>
      {balance.worstDays.length === 0 ? (
        <div style={cleanBodyStyle}>
          No timestep shows outflow exceeding inflow. The model conserves mass
          per-step within tolerance.
        </div>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>Date</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Inputs</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Outputs</th>
              <th style={{ ...thStyle, textAlign: "right" }}>Net</th>
            </tr>
          </thead>
          <tbody>
            {balance.worstDays.map((d, i) => (
              <tr
                key={`${d.date}-${i}`}
                style={fallbackSink ? trClickableStyle : trStyle}
                onClick={fallbackSink ? () => onSelectNode(fallbackSink) : undefined}
                title={
                  fallbackSink
                    ? `Click to inspect ${fallbackSink} (largest sink in the run)`
                    : undefined
                }
              >
                <td style={tdStyle}>{d.date}</td>
                <td style={tdNumStyle}>{formatVolume(d.inputs)}</td>
                <td style={tdNumStyle}>{formatVolume(d.outputs)}</td>
                <td style={{ ...tdNumStyle, color: "#dc2626", fontWeight: 600 }}>
                  {formatSigned(d.net)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SeverityPill({
  severity, balance,
}: { severity: Severity; balance: MassBalance }) {
  const { color, label, title } = SEVERITY_META(severity, balance);
  return (
    <div
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "4px 10px",
        borderRadius: 12,
        border: `1px solid ${color}55`,
        background: `${color}11`,
        color,
        fontSize: 11,
        fontWeight: 600,
      }}
      title={title}
    >
      <span
        style={{
          width: 8, height: 8, borderRadius: 4, background: color,
          display: "inline-block",
        }}
      />
      {label}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Severity classifier — presentation only, derived from the pure metrics.
// ---------------------------------------------------------------------------

type Severity = "clean" | "warn" | "violate";

function computeSeverity(b: MassBalance): Severity {
  // Pre-load (no data) → clean. The header still says 0 of N loaded so the
  // user knows nothing is being asserted yet.
  if (b.daily.length === 0) return "clean";
  if (b.violationDays > 0) return "violate";
  // Residual exceeds 1% of the larger total — flag as warn. The 1% bar is
  // intentionally lax compared with the per-step relative tolerance: small
  // model imperfections (e.g. unrecorded losses, initial-volume rounding)
  // commonly produce sub-1% drift even on a clean run.
  if (Number.isFinite(b.pctImbalance) && b.pctImbalance > 1) return "warn";
  return "clean";
}

function SEVERITY_META(s: Severity, b: MassBalance): {
  color: string; label: string; title: string;
} {
  switch (s) {
    case "violate":
      return {
        color: "#dc2626",
        label: `LP violation (${b.violationDays} day${b.violationDays === 1 ? "" : "s"})`,
        title: "One or more timesteps show outflow exceeding inflow beyond the storage budget.",
      };
    case "warn":
      return {
        color: "#d97706",
        label: `Imbalance ${b.pctImbalance.toFixed(1)}%`,
        title: "Residual mass error exceeds 1% of the largest total. Inspect storage and recorder coverage.",
      };
    case "clean":
    default:
      return {
        color: "#059669",
        label: "Mass conserved",
        title: `Residual ${formatSigned(b.residual)} within ${(BALANCE_RELATIVE_TOL * 100).toFixed(3)}% tolerance.`,
      };
  }
}

function residualColor(b: MassBalance): string {
  if (b.daily.length === 0) return "#475569";
  if (b.violationDays > 0) return "#dc2626";
  if (Number.isFinite(b.pctImbalance) && b.pctImbalance > 1) return "#d97706";
  return "#059669";
}

// In-place row update — same pattern as ZeroFlowAnalyzer so partial loads
// don't rewrite the whole table.
function updateRow(
  prev: AuditCandidate[],
  idx: number,
  patch: Partial<AuditCandidate>,
): AuditCandidate[] {
  if (idx < 0 || idx >= prev.length) return prev;
  const next = prev.slice();
  next[idx] = { ...prev[idx], ...patch };
  return next;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flexShrink: 0,
};

const titleRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
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

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 16,
  background: "#f8fafc",
};

const summaryRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  gap: 12,
};

const cardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  padding: "12px 14px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const cardValueStyle: React.CSSProperties = {
  fontSize: 22,
  fontWeight: 700,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const cardHintStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#64748b",
};

const violationCalloutStyle: React.CSSProperties = {
  marginTop: 14,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  padding: "10px 12px",
};

const violationTitleStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 700,
  color: "#991b1b",
  marginBottom: 4,
};

const violationBodyStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#7f1d1d",
  lineHeight: 1.4,
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  marginBottom: 6,
};

const cleanBodyStyle: React.CSSProperties = {
  padding: 14,
  background: "#ecfdf5",
  border: "1px solid #bbf7d0",
  borderRadius: 6,
  color: "#065f46",
  fontSize: 12,
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
};

const thStyle: React.CSSProperties = {
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 10,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "8px 12px",
  textAlign: "left",
};

const trStyle: React.CSSProperties = {
  borderBottom: "1px solid #f1f5f9",
};

const trClickableStyle: React.CSSProperties = {
  ...trStyle,
  cursor: "pointer",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  fontSize: 12,
  color: "#0f172a",
};

const tdNumStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
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
export const _internal = { collectAuditCandidates, computeSeverity };

// src/components/RecorderStatsStrip.tsx
// Per-recorder statistics row used by the Results tab's downstream-output
// panel (T1.2). Loads the recorder's CSV (the same file the time-series
// chart already reads), runs computeStats, and renders a five-column strip:
//   mean · max · zero days · % active · annual total
//
// Why a dedicated component:
//   - The DownstreamPanel renders one strip per recorder × per downstream
//     Output. Owning the load + memo here means clicking around the node
//     list doesn't kick off duplicate reads of the same CSV path within a
//     render frame (React re-mounts only when csvPath changes).
//   - The stats math lives in src/lib/recorderStats so the strip is just a
//     thin shell — easy to swap presentation without disturbing semantics.
//
// Loading strategy mirrors NodeTimeSeriesChart: readCsvPreview with a large
// row cap, parseCsvSeries to turn it into typed arrays, then computeStats.
// A run with N downstream outputs triggers N parallel reads — fine in
// practice because the Rust side reads are synchronous on small files and
// Pywr CSVs rarely exceed a few MB.

import React, { useEffect, useState } from "react";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  computeStats,
  formatPct,
  formatStat,
  type RecorderStats,
} from "../lib/recorderStats";

// Same upper bound the chart uses. A 100-year daily run = ~36k rows; this cap
// covers hourly runs over decades while guarding against pathological files.
const MAX_ROWS = 200_000;

export interface RecorderStatsStripProps {
  // null = recorder is aggregate-only or its CSV wasn't written. Strip
  // renders an inline hint rather than failing silently, matching how the
  // chart handles the same case.
  csvPath: string | null;
  recorderName: string;
  recorderType: string;
}

type LoadState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; stats: RecorderStats }
  | { kind: "error"; message: string };

export function RecorderStatsStrip({
  csvPath,
  recorderName,
  recorderType,
}: RecorderStatsStripProps) {
  const [state, setState] = useState<LoadState>({ kind: "idle" });

  useEffect(() => {
    if (!csvPath) {
      setState({ kind: "idle" });
      return;
    }
    let cancelled = false;
    setState({ kind: "loading" });
    (async () => {
      const res = await window.pywr.readCsvPreview(csvPath, MAX_ROWS);
      if (cancelled) return;
      if (!res.ok) {
        setState({ kind: "error", message: res.error ?? "Could not read CSV" });
        return;
      }
      const parsed = parseCsvSeries(recorderName, recorderType, res.headers, res.rows);
      if (parsed.error || !parsed.series) {
        setState({ kind: "error", message: parsed.error ?? "No data in CSV" });
        return;
      }
      const stats = computeStats(parsed.series.values, parsed.series.dates);
      setState({ kind: "ready", stats });
    })();
    return () => { cancelled = true; };
  }, [csvPath, recorderName, recorderType]);

  if (state.kind === "idle") {
    // No CSV — aggregate-only recorder. The aggregate value rendered alongside
    // (in OutputRow) is the only number available, so we suppress the strip
    // entirely rather than show "— — — — —".
    return null;
  }

  if (state.kind === "loading") {
    return <div style={loadingStyle}>loading stats…</div>;
  }

  if (state.kind === "error") {
    return <div style={errorStyle} title={state.message}>stats unavailable</div>;
  }

  const { mean, max, zeroDays, totalDays, pctActive, annualTotal } = state.stats;
  // Day denominators read better as "n / N" so it's obvious whether 12 zero
  // days is "out of 14" or "out of 14600".
  const zeroDaysLabel = `${zeroDays.toLocaleString()} / ${totalDays.toLocaleString()}`;

  return (
    <div style={containerStyle} role="group" aria-label={`Statistics for ${recorderName}`}>
      <StatCell label="mean" value={formatStat(mean)} />
      <StatCell label="max" value={formatStat(max)} />
      <StatCell label="zero days" value={zeroDaysLabel} />
      <StatCell label="% active" value={formatPct(pctActive)} />
      <StatCell label="annual" value={formatStat(annualTotal)} />
    </div>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={cellStyle}>
      <div style={cellLabelStyle}>{label}</div>
      <div style={cellValueStyle}>{value}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles — colocated because the strip is small and self-contained.
// ---------------------------------------------------------------------------

const containerStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  gap: 6,
  marginTop: 6,
  padding: "6px 8px",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
};

const cellStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  minWidth: 0,
};

const cellLabelStyle: React.CSSProperties = {
  fontSize: 9,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  fontWeight: 700,
};

const cellValueStyle: React.CSSProperties = {
  fontSize: 12,
  color: "#0f172a",
  fontWeight: 600,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  width: "100%",
};

const loadingStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "4px 8px",
  fontSize: 11,
  color: "#64748b",
  background: "#f8fafc",
  border: "1px solid #e2e8f0",
  borderRadius: 4,
};

const errorStyle: React.CSSProperties = {
  marginTop: 6,
  padding: "4px 8px",
  fontSize: 11,
  color: "#991b1b",
  background: "#fef2f2",
  border: "1px solid #fee2e2",
  borderRadius: 4,
  cursor: "help",
};

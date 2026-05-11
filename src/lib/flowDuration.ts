// src/lib/flowDuration.ts
// Pure helpers for the T2.6 flow-duration-curve (FDC) view.
//
// An FDC plots flow magnitude (y-axis) against the fraction of time the flow
// equals or exceeds that magnitude (x-axis). Operationally it answers
// "how much of the time does this node carry more than X?" — the question a
// reservoir engineer asks before sizing a licence cap, and the question a
// flood modeller asks before quoting a return-period flow.
//
// Why a separate file from recorderStats / massBalance:
//   - recorderStats reduces a series to scalars (mean/max/etc).
//   - massBalance compares N series against M series across the system.
//   - flowDuration takes ONE series and re-orders it. Different operation,
//     different invariants, so I'd rather have three tight files than one
//     fat one. Future T2.7 (deficit dashboard) will share the ranking logic
//     and import from here.
//
// Exceedance probability formula — Weibull plotting position, i/(N+1):
//   - Most defensible default in hydrology when the population is unknown.
//   - Avoids the 0% / 100% endpoints that ((i-1)/N or i/N) would put right
//     on the frame edge.
//   - Easy to swap to Gringorten/Cunnane via the `formula` option if a user
//     ever needs to match a reference report. Not exposed in the UI yet.
//
// Multi-scenario handling: we collapse to cross-scenario mean before
// ranking. Same call as massBalance — the ensemble mean is the operational
// FDC across scenarios. If a future revision wants per-scenario curves on
// the same axes, change the return shape; for now we keep it scalar.

import { collapseScenarios } from "./massBalance";

// One point on the FDC. `exceedance` is in [0, 1] — fraction of time flow
// is ≥ this value. `flow` is the cross-scenario mean for that rank.
export interface FlowDurationPoint {
  exceedance: number;
  flow: number;
}

// Plotting-position formulas. Weibull is the project default.
export type PlottingFormula = "weibull" | "gringorten" | "cunnane";

// Compute the FDC for a single recorder's CSV-shape values.
//
// `values[rowIdx][scenarioIdx]` matches parseCsvSeries output. We:
//   1. Collapse scenarios to the per-step mean.
//   2. Drop non-finite samples — gaps don't count toward exceedance.
//   3. Sort descending.
//   4. Assign plotting position i/(N+1) per rank (Weibull).
//
// Pure: deterministic given the same input. The component layer renders
// these points to SVG; no presentation concerns live here.
export function computeFlowDuration(
  values: number[][],
  opts: { formula?: PlottingFormula } = {},
): FlowDurationPoint[] {
  const formula = opts.formula ?? "weibull";
  const collapsed = collapseScenarios(values);
  const finite: number[] = [];
  for (const v of collapsed) {
    if (Number.isFinite(v)) finite.push(v);
  }
  if (finite.length === 0) return [];
  // Sort descending — rank 1 is the largest flow.
  finite.sort((a, b) => b - a);
  const n = finite.length;
  const out: FlowDurationPoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    // i is 0-based; convert to 1-based rank for the plotting position so the
    // formulas read like the textbook (Weibull: i/(N+1) with i=1..N).
    const rank = i + 1;
    out[i] = { exceedance: plottingPosition(rank, n, formula), flow: finite[i] };
  }
  return out;
}

// Plotting-position formulas. Exported for unit tests so the formula
// choice is pinned, not buried.
export function plottingPosition(
  rank: number, // 1..N
  n: number,
  formula: PlottingFormula = "weibull",
): number {
  if (n <= 0) return NaN;
  switch (formula) {
    case "gringorten":
      // (i - 0.44) / (N + 0.12) — popular for extreme-value analysis.
      return (rank - 0.44) / (n + 0.12);
    case "cunnane":
      // (i - 0.4) / (N + 0.2) — preferred when distribution is unknown.
      return (rank - 0.4) / (n + 0.2);
    case "weibull":
    default:
      return rank / (n + 1);
  }
}

// Look up the flow value that is exceeded exactly `frac` of the time.
// `frac` is in [0, 1]; we find the rank whose plotting position matches
// most closely, falling back to linear interpolation when the requested
// fraction sits between two ranks.
//
// Useful for the hover/probe interaction on the FDC chart, and for spot-
// checking "what's the Q90 flow?" without hand-counting points.
export function flowAtExceedance(
  points: FlowDurationPoint[],
  frac: number,
): number {
  if (points.length === 0 || !Number.isFinite(frac)) return NaN;
  if (frac <= points[0].exceedance) return points[0].flow;
  if (frac >= points[points.length - 1].exceedance) {
    return points[points.length - 1].flow;
  }
  // Linear interpolation between adjacent points. Points are sorted by
  // ascending exceedance because we built them in descending flow order
  // and plotting position grows with rank.
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1];
    const cur = points[i];
    if (frac <= cur.exceedance) {
      const t = (frac - prev.exceedance) / (cur.exceedance - prev.exceedance);
      return prev.flow + t * (cur.flow - prev.flow);
    }
  }
  return points[points.length - 1].flow;
}

// Convenience: standard exceedance quantiles used in hydrology reporting.
// Q10 = flow exceeded 10% of time (high flow); Q90 = exceeded 90% (low flow).
export const STANDARD_EXCEEDANCE_QUANTILES = [0.05, 0.1, 0.5, 0.9, 0.95] as const;

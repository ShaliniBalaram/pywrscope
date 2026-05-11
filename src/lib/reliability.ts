// src/lib/reliability.ts
// Pure helpers for the T2.7 deficit / reliability dashboard.
//
// "Reliability" for an Output node: the fraction of timesteps where the
// recorded flow met the demand (max_flow) within tolerance. A perfectly-
// supplied demand has reliability 100%; one that's never satisfied has 0%.
//
// Mirrors notebook DIAG-5 / N-2 / N-3. The notebook iterates outputs,
// pairs each with its numeric max_flow, and reports the league table. This
// file keeps every metric pure so the dashboard component can be tested at
// the math level without rendering React.
//
// Demand semantics — strict:
//   - Numeric max_flow on the node is treated as a fixed demand.
//   - Parameter references (string max_flow like "demand_profile") are NOT
//     resolved here. Resolving them would require evaluating Pywr parameters
//     over time, which is out of scope. We surface those nodes in the
//     dashboard with `kind: "parameter"` so the user can spot them and run
//     the parameter resolution if needed (T3 territory).
//   - max_flow == undefined / null → "unconstrained"; reliability isn't
//     meaningful. Reported with `kind: "unconstrained"`.

import { computeStats, STATS_EPS } from "./recorderStats";
import { collapseScenarios } from "./massBalance";

// Default tolerance: a delivery within 1% of demand counts as "met". Below
// that we count the day as a deficit. Operationally this is the same band
// the notebook used; smaller tolerances are too sensitive to LP roundoff.
export const RELIABILITY_TOL = 0.01;

export type DemandKind = "numeric" | "parameter" | "unconstrained";

export interface ExtractedDemand {
  kind: DemandKind;
  // numeric only: the fixed max_flow. NaN otherwise.
  value: number;
  // For "parameter": the referenced parameter name. Empty otherwise.
  paramName: string;
}

// Extract the demand value from a node's max_flow field. Pure; exported
// for unit tests so the parameter-vs-numeric split is pinned.
export function extractDemand(maxFlow: unknown): ExtractedDemand {
  if (typeof maxFlow === "number" && Number.isFinite(maxFlow)) {
    return { kind: "numeric", value: maxFlow, paramName: "" };
  }
  if (typeof maxFlow === "string" && maxFlow.length > 0) {
    return { kind: "parameter", value: NaN, paramName: maxFlow };
  }
  return { kind: "unconstrained", value: NaN, paramName: "" };
}

export interface ReliabilityStats {
  // Number of timesteps with finite supply data.
  totalDays: number;
  // Timesteps where flow + tol < demand.
  deficitDays: number;
  // Reliability = (totalDays - deficitDays) / totalDays × 100. NaN when
  // totalDays is 0.
  pctReliability: number;
  // Longest consecutive run of deficit days. Used to surface "the longest
  // dry spell" — far more operationally relevant than just the total count.
  longestDeficitRun: number;
  // Sum over deficit days of (demand - flow). Reported in flow units × days.
  totalShortfall: number;
  // Mean shortfall per deficit day. NaN when deficitDays is 0.
  meanShortfall: number;
}

const NAN_RELIABILITY: ReliabilityStats = {
  totalDays: 0,
  deficitDays: 0,
  pctReliability: NaN,
  longestDeficitRun: 0,
  totalShortfall: 0,
  meanShortfall: NaN,
};

// Compute reliability for one Output node from its parsed CSV values.
//
// `values[rowIdx][scenarioIdx]` — same shape as parseCsvSeries. We collapse
// to the cross-scenario mean before comparing to demand, matching the
// massBalance and FDC conventions.
//
// `demand` is the fixed numeric max_flow. NaN demand short-circuits to a
// NaN-stats object — the dashboard handles that as "n/a".
//
// `tolerance` is the fractional tolerance (default RELIABILITY_TOL = 1%).
// A day with flow ≥ demand × (1 - tolerance) counts as met. Setting it
// looser (e.g. 0.05) is useful when the model uses noisy parameter
// references that don't deliver an exact target.
export function computeReliability(
  values: number[][],
  demand: number,
  opts: { tolerance?: number } = {},
): ReliabilityStats {
  if (!Number.isFinite(demand) || demand <= 0) return { ...NAN_RELIABILITY };
  const tol = opts.tolerance ?? RELIABILITY_TOL;
  // Absolute floor: a demand-times-tolerance window narrower than STATS_EPS
  // would flag IEEE noise. Take the larger of the two so tiny demands don't
  // false-flag.
  const threshold = demand * (1 - tol);
  const absFloor = Math.max(STATS_EPS, threshold);

  const collapsed = collapseScenarios(values);

  let totalDays = 0;
  let deficitDays = 0;
  let longestRun = 0;
  let currentRun = 0;
  let totalShortfall = 0;

  for (const v of collapsed) {
    if (!Number.isFinite(v)) {
      // Missing cell — break the run but don't count as a day either way.
      // Same defensive choice computeStats makes.
      currentRun = 0;
      continue;
    }
    totalDays++;
    if (v < absFloor) {
      deficitDays++;
      currentRun++;
      if (currentRun > longestRun) longestRun = currentRun;
      totalShortfall += demand - v;
    } else {
      currentRun = 0;
    }
  }

  const pctReliability = totalDays === 0
    ? NaN
    : ((totalDays - deficitDays) / totalDays) * 100;
  const meanShortfall = deficitDays === 0 ? NaN : totalShortfall / deficitDays;

  return {
    totalDays,
    deficitDays,
    pctReliability,
    longestDeficitRun: longestRun,
    totalShortfall,
    meanShortfall,
  };
}

// Format reliability % for display. Uses one-decimal precision in the
// middle band, clean "100%" / "0%" at the extremes. NaN → em-dash.
// Mirrors recorderStats.formatPct — duplicated here so this file can be
// imported without dragging in the rest of recorderStats.
export function formatReliability(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 99.95) return "100%";
  if (v <= 0.05) return "0%";
  return `${v.toFixed(1)}%`;
}

// Severity for the dashboard's traffic-light dot. Operational thresholds:
//   - critical : < 80% reliability (one in five days fails)
//   - warn     : 80–94% (still a regular failure mode)
//   - ok       : ≥ 95% (typical operational target)
export type ReliabilitySeverity = "critical" | "warn" | "ok";

export const RELIABILITY_CRITICAL_PCT = 80;
export const RELIABILITY_WARN_PCT = 95;

export function severityForReliability(pct: number): ReliabilitySeverity {
  if (!Number.isFinite(pct)) return "ok"; // unknown ≠ red
  if (pct < RELIABILITY_CRITICAL_PCT) return "critical";
  if (pct < RELIABILITY_WARN_PCT) return "warn";
  return "ok";
}

// Re-export shared helper so the reliability dashboard doesn't need to know
// it lives in recorderStats.
export { computeStats } from "./recorderStats";

// ---------------------------------------------------------------------------
// T3.8 — deficit event extraction
// ---------------------------------------------------------------------------
//
// "Event" = a maximal run of consecutive timesteps where supply < demand
// (within tolerance). The reliability stats only report the longest single
// run; the events log decomposes the whole horizon into a list of distinct
// events with start, end, duration, and shortfall summaries. The notebook's
// EDO log is essentially this output, sorted by duration.

export interface DeficitEvent {
  // Indices into the original (date, value) arrays — inclusive on both ends.
  // We keep them on the event so a downstream renderer can offset back into
  // the time series if it wants to highlight the affected range.
  startIndex: number;
  endIndex: number;
  startDate: string;
  endDate: string;
  // endIndex - startIndex + 1.
  duration: number;
  // Sum (demand - flow) over the event.
  totalShortfall: number;
  // Worst single-step shortfall in the event.
  peakShortfall: number;
  // totalShortfall / duration.
  meanShortfall: number;
}

// Default minimum duration for an event to be reported. The notebook's
// drought-event log started at ≥7 days; below that the table fills up with
// single-step noise on a 100-year run. Caller can override via opts.
export const DEFAULT_MIN_EVENT_DAYS = 7;

// Extract deficit events from a parsed-CSV flow stream. Pure; mirrors the
// scanner shape used by computeReliability but emits one record per run
// instead of just tracking the maximum.
//
// `dates[i]` is the ISO date for `values[i]`. Both arrays must have the
// same length; mismatched lengths short-circuit to []. A NaN cell breaks
// the run, identically to computeReliability.
export function extractDeficitEvents(
  values: number[][],
  dates: string[],
  demand: number,
  opts: { tolerance?: number; minDuration?: number } = {},
): DeficitEvent[] {
  if (!Number.isFinite(demand) || demand <= 0) return [];
  if (values.length !== dates.length) return [];

  const tol = opts.tolerance ?? RELIABILITY_TOL;
  const minDur = opts.minDuration ?? DEFAULT_MIN_EVENT_DAYS;
  const threshold = demand * (1 - tol);
  // Pull collapseScenarios at call time (not module-load) so this file's
  // export graph stays acyclic — reliability.ts importing massBalance.ts is
  // already a one-way edge today.
  const collapsed = collapseScenariosLocal(values);

  const events: DeficitEvent[] = [];
  let runStart = -1;
  let runShortSum = 0;
  let runShortPeak = 0;

  const flushIfLongEnough = (endExclusive: number) => {
    if (runStart < 0) return;
    const duration = endExclusive - runStart;
    if (duration >= minDur) {
      events.push({
        startIndex: runStart,
        endIndex: endExclusive - 1,
        startDate: dates[runStart],
        endDate: dates[endExclusive - 1],
        duration,
        totalShortfall: runShortSum,
        peakShortfall: runShortPeak,
        meanShortfall: runShortSum / duration,
      });
    }
    runStart = -1;
    runShortSum = 0;
    runShortPeak = 0;
  };

  for (let i = 0; i < collapsed.length; i++) {
    const v = collapsed[i];
    if (!Number.isFinite(v)) {
      // Missing data breaks the run, same defensive choice as computeReliability.
      flushIfLongEnough(i);
      continue;
    }
    if (v < threshold) {
      if (runStart < 0) runStart = i;
      const short = demand - v;
      runShortSum += short;
      if (short > runShortPeak) runShortPeak = short;
    } else {
      flushIfLongEnough(i);
    }
  }
  flushIfLongEnough(collapsed.length);

  return events;
}

// Local re-implementation of collapseScenarios — see top-of-file note. We
// avoid importing massBalance just for one helper because doing so couples
// reliability.ts to a heavier module (formatVolume, computeMassBalance, etc.)
// when only one trivial function is needed.
function collapseScenariosLocal(values: number[][]): number[] {
  const out = new Array<number>(values.length);
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    let sum = 0;
    let count = 0;
    for (let s = 0; s < row.length; s++) {
      const v = row[s];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    out[i] = count === 0 ? NaN : sum / count;
  }
  return out;
}

// Per-demand-centre summary derived from a list of events. Used by the
// events component to render the "summary strip" alongside the events
// table — mirrors the notebook's "events per DC" bar chart.
export interface EventSummary {
  count: number;
  meanDuration: number; // NaN when count is 0
  maxDuration: number;
  totalShortfall: number;
}

export function summariseEvents(events: DeficitEvent[]): EventSummary {
  if (events.length === 0) {
    return { count: 0, meanDuration: NaN, maxDuration: 0, totalShortfall: 0 };
  }
  let totalDur = 0;
  let maxDur = 0;
  let totalShort = 0;
  for (const e of events) {
    totalDur += e.duration;
    if (e.duration > maxDur) maxDur = e.duration;
    totalShort += e.totalShortfall;
  }
  return {
    count: events.length,
    meanDuration: totalDur / events.length,
    maxDuration: maxDur,
    totalShortfall: totalShort,
  };
}

// ---------------------------------------------------------------------------
// T3.9 — concurrent-failure indicator + matrix
// ---------------------------------------------------------------------------
//
// `computeDeficitIndicator` collapses a multi-scenario series to a per-step
// 0/1/-1 indicator using the same threshold as `computeReliability`. The
// concurrent-failure timeseries renders one row per Output and sums down
// columns to surface "how many demand centres failed simultaneously today".
//
// Encoding (Int8Array so a 100-year run × 200 Outputs stays under 8 MB rather
// than 64 MB for a Float64 grid):
//   1  → deficit (flow < demand × (1 - tolerance))
//   0  → demand met
//  -1  → no finite data this step (carried as a sentinel so the heatmap can
//        render a neutral cell rather than miscount it as "met")
//
// Returns an empty Int8Array when demand is non-positive / NaN. That matches
// the "skip" semantics computeReliability uses, so callers can blanket-loop
// over candidates without branching on demandKind.

export const DEFICIT_SENTINEL_NO_DATA = -1;
export const DEFICIT_SENTINEL_MET = 0;
export const DEFICIT_SENTINEL_FAIL = 1;

export function computeDeficitIndicator(
  values: number[][],
  demand: number,
  opts: { tolerance?: number } = {},
): Int8Array {
  if (!Number.isFinite(demand) || demand <= 0) return new Int8Array(0);
  const tol = opts.tolerance ?? RELIABILITY_TOL;
  const threshold = demand * (1 - tol);
  // Same absolute-floor guard as computeReliability — without it, demands much
  // smaller than STATS_EPS would flag IEEE noise as a deficit.
  const absFloor = Math.max(STATS_EPS, threshold);
  const collapsed = collapseScenariosLocal(values);
  const out = new Int8Array(collapsed.length);
  for (let i = 0; i < collapsed.length; i++) {
    const v = collapsed[i];
    if (!Number.isFinite(v)) {
      out[i] = DEFICIT_SENTINEL_NO_DATA;
      continue;
    }
    out[i] = v < absFloor ? DEFICIT_SENTINEL_FAIL : DEFICIT_SENTINEL_MET;
  }
  return out;
}

// One node's deficit row plus identity. The matrix builder consumes a list of
// these (one per Output) and emits the aligned cross-network matrix used by
// the concurrent-failure chart + heatmap.
export interface ConcurrentFailureRow {
  nodeName: string;
  recorderName: string;
  dates: string[];
  // Same encoding as computeDeficitIndicator.
  indicator: Int8Array;
}

export interface ConcurrentFailureMatrix {
  // Ordered node names, sorted descending by per-node deficit-day total so the
  // worst offenders sit at the top of the heatmap.
  nodes: string[];
  // ISO dates from the reference timeline. Length determines column count.
  dates: string[];
  // Per-node deficit row, aligned to `dates`. matrix[nodeIdx][dateIdx] uses the
  // same sentinel encoding as computeDeficitIndicator.
  matrix: Int8Array[];
  // Number of nodes in deficit per timestep. Length === dates.length. Used as
  // the headline line chart above the heatmap.
  perDayCount: number[];
  // Total deficit days per node, aligned to `nodes`. Used for the row labels
  // and the sort order.
  perNodeTotals: number[];
  // Day index (into `dates`) of the worst day (highest concurrent count) — or
  // -1 when no rows are present. Surfaced as a "drought peak" marker.
  worstDayIndex: number;
  // Maximum concurrent-deficit count observed. 0 when no rows.
  peakConcurrent: number;
  // How many supplied rows had to be dropped because their dates couldn't be
  // aligned to the reference timeline. Surfaced in the UI so the user knows
  // partial data is being shown.
  droppedRows: number;
}

// Build the matrix from a list of per-node deficit rows. Pure; exported for
// unit tests.
//
// Alignment rule — strict but predictable:
//   - The reference timeline is the LONGEST `dates` array among the supplied
//     rows (ties broken by first occurrence). All other rows must have the
//     same length AND every date string must match position-wise; otherwise
//     that row is dropped (counted in `droppedRows`) so the matrix stays
//     rectangular. Pywr runs share a single timestepper, so length+identity
//     alignment is the realistic common case — we don't try to merge mismatched
//     horizons because that would mask a model-side bug (mixed recorder
//     ranges) behind silent NaN padding.
export function buildConcurrentFailureMatrix(
  rows: ConcurrentFailureRow[],
): ConcurrentFailureMatrix {
  if (rows.length === 0) {
    return {
      nodes: [],
      dates: [],
      matrix: [],
      perDayCount: [],
      perNodeTotals: [],
      worstDayIndex: -1,
      peakConcurrent: 0,
      droppedRows: 0,
    };
  }
  // Pick reference timeline = longest row (ties: first). Using length first
  // lets us short-circuit identity comparison for the common case where every
  // row already matches.
  let refIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].dates.length > rows[refIdx].dates.length) refIdx = i;
  }
  const refDates = rows[refIdx].dates;
  const refLen = refDates.length;

  const kept: ConcurrentFailureRow[] = [];
  let dropped = 0;
  for (const r of rows) {
    if (r.dates.length !== refLen || r.indicator.length !== refLen) {
      dropped++;
      continue;
    }
    // Identity check — every position must match. We don't try date parsing
    // here because the reference came from a real recorder CSV and any
    // mismatch is a structural problem the user should see.
    let aligned = true;
    for (let i = 0; i < refLen; i++) {
      if (r.dates[i] !== refDates[i]) { aligned = false; break; }
    }
    if (!aligned) { dropped++; continue; }
    kept.push(r);
  }

  // Per-node totals first so we can sort rows before building the final
  // matrix. Sort is descending by total deficit days; ties broken by node name
  // for stable rendering. Nodes with zero deficit days still appear so the
  // heatmap shows green for them (useful as a "look, this DC never failed"
  // marker).
  const totalsByIdx = kept.map((r) => {
    let t = 0;
    for (let i = 0; i < refLen; i++) if (r.indicator[i] === DEFICIT_SENTINEL_FAIL) t++;
    return t;
  });
  const order = kept.map((_, i) => i).sort((a, b) => {
    if (totalsByIdx[a] !== totalsByIdx[b]) return totalsByIdx[b] - totalsByIdx[a];
    return kept[a].nodeName.localeCompare(kept[b].nodeName);
  });

  const nodes = order.map((i) => kept[i].nodeName);
  const matrix = order.map((i) => kept[i].indicator);
  const perNodeTotals = order.map((i) => totalsByIdx[i]);

  // Per-day concurrent count: sum the deficit-flagged rows down each column.
  // No-data sentinels are skipped (matches "the day didn't fail, but we also
  // can't claim it succeeded" intuition — operationally closer to "unknown").
  const perDayCount = new Array<number>(refLen).fill(0);
  for (const row of matrix) {
    for (let i = 0; i < refLen; i++) {
      if (row[i] === DEFICIT_SENTINEL_FAIL) perDayCount[i]++;
    }
  }

  let peak = 0;
  let peakIdx = -1;
  for (let i = 0; i < refLen; i++) {
    if (perDayCount[i] > peak) {
      peak = perDayCount[i];
      peakIdx = i;
    }
  }

  return {
    nodes,
    dates: refDates,
    matrix,
    perDayCount,
    perNodeTotals,
    worstDayIndex: peakIdx,
    peakConcurrent: peak,
    droppedRows: dropped,
  };
}

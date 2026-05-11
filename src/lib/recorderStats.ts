// src/lib/recorderStats.ts
// Pure statistics for one recorder's CSV time-series, used by the Results
// tab's per-node statistics table (T1.2). Mirrors notebook DIAG-3/4/5.
//
// Why a separate file: every metric here is a pure function of (values, dates).
// Keeping them out of the component lets the test suite pin down the maths
// without ever rendering React, and lets future diagnostics (T1.3 zero-flow
// analyzer, T1.4 mass balance) reuse the same definitions instead of
// re-implementing them with subtly different rounding.
//
// Multi-scenario semantics — fixed across this module so callers don't have to
// re-derive them per stat:
//   - mean : mean of every finite (scenario × timestep) value
//   - max  : max of every finite (scenario × timestep) value
//   - zeroDays : count of timesteps whose cross-scenario mean is ~0. Using the
//                mean (not "all scenarios zero") matches how DIAG-5 reports
//                deficits in the notebook — a step where the average outcome
//                is zero is the operational definition of inactivity even if
//                one scenario carried a trickle.
//   - annualTotal : annualise each scenario's sum, then average. Lets a model
//                   with three scenarios produce one summary number aligned
//                   with how Pywr's aggregated_value() defaults work.
//
// `dates` is parallel to the value rows (ISO-8601 strings). If the first and
// last date can be parsed, annualTotal is sum_per_scenario × 365.25 / day_span,
// averaged across scenarios. If they can't be parsed (custom format, malformed
// CSV), annualTotal is NaN — better signal than a fabricated number.

// Same epsilon used elsewhere for "is this value really nonzero?" (ResultsTab,
// useRunResults). Kept identical so a node flagged active in one place isn't
// flagged inactive here.
export const STATS_EPS = 1e-9;

const MS_PER_DAY = 86_400_000;
const DAYS_PER_YEAR = 365.25;

export interface RecorderStats {
  // Mean over all finite (scenario × timestep) values. NaN when no finite
  // values exist (empty series, or every cell is blank).
  mean: number;
  // Max over all finite values. NaN when no finite values exist.
  max: number;
  // Number of timesteps whose cross-scenario mean lies within ±STATS_EPS of 0.
  zeroDays: number;
  // Number of timesteps that contributed at least one finite value. Used as
  // the denominator for pctActive so a series with blank rows doesn't inflate
  // the "active" share.
  totalDays: number;
  // (totalDays - zeroDays) / totalDays × 100. NaN when totalDays is 0.
  pctActive: number;
  // Annualised total flow (units of values × days), averaged across scenarios.
  // NaN when day-span can't be derived from the supplied dates.
  annualTotal: number;
}

const NAN_STATS: RecorderStats = {
  mean: NaN,
  max: NaN,
  zeroDays: 0,
  totalDays: 0,
  pctActive: NaN,
  annualTotal: NaN,
};

// Parse an ISO-8601 date (or anything Date can recognise) to ms since epoch.
// Returns NaN on failure rather than throwing — callers fall back to NaN
// annualTotal in that case.
export function parseIsoDateMs(s: string): number {
  if (!s) return NaN;
  // Date.parse accepts ISO-8601 directly. We don't try to be clever with
  // locale-specific formats; run_pywr.py only emits ISO dates and any other
  // CSV in this app is owned by the user — surfacing NaN is the honest answer.
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : NaN;
}

// Span between first and last date, in days. Returns NaN when either bound is
// unparseable. A single-day window yields 0 days (caller decides how to handle
// that — we don't fake a year-long span).
export function dateSpanDays(dates: string[]): number {
  if (dates.length < 2) return NaN;
  const first = parseIsoDateMs(dates[0]);
  const last = parseIsoDateMs(dates[dates.length - 1]);
  if (!Number.isFinite(first) || !Number.isFinite(last)) return NaN;
  // +1 step interval — Pywr timesteps are inclusive at both ends so the span
  // covers (last - first) + 1 timestep. Without the +1, a 365-row daily run
  // reports as 364 days and inflates annualTotal by ~0.3%.
  const span = (last - first) / MS_PER_DAY + 1;
  return span > 0 ? span : NaN;
}

// Compute every stat for one recorder's CSV. Pure; exported for unit tests
// and for reuse by future T1.3/T1.4 diagnostics.
//
// `values[rowIdx][scenarioIdx]` matches the shape produced by parseCsvSeries
// in NodeTimeSeriesChart — NaN flags missing cells, finite numbers flag data.
// `dates[rowIdx]` is the ISO-8601 string for the same row.
export function computeStats(
  values: number[][],
  dates: string[],
  opts: { eps?: number } = {},
): RecorderStats {
  const eps = opts.eps ?? STATS_EPS;
  if (values.length === 0) return { ...NAN_STATS };

  // We scan once and collect: global finite sum/count for mean, global max,
  // per-scenario sum for annualTotal, per-row cross-scenario mean for zeroDays.
  // One pass keeps this O(rows × scenarios) regardless of how many stats grow.
  const scenarioCount = values[0]?.length ?? 0;
  if (scenarioCount === 0) return { ...NAN_STATS };

  let globalSum = 0;
  let globalCount = 0;
  let globalMax = -Infinity;
  // Per-scenario sums for annualTotal. Scenarios with zero finite cells
  // contribute NaN (skipped from the cross-scenario mean) so a sparse scenario
  // doesn't drag the annualised average toward 0.
  const perScenarioSum = new Array<number>(scenarioCount).fill(0);
  const perScenarioFinite = new Array<number>(scenarioCount).fill(0);

  let zeroDays = 0;
  let totalDays = 0;

  for (const row of values) {
    let rowFiniteCount = 0;
    let rowFiniteSum = 0;
    for (let s = 0; s < scenarioCount; s++) {
      const v = row[s];
      if (!Number.isFinite(v)) continue;
      globalSum += v;
      globalCount++;
      if (v > globalMax) globalMax = v;
      perScenarioSum[s] += v;
      perScenarioFinite[s]++;
      rowFiniteSum += v;
      rowFiniteCount++;
    }
    if (rowFiniteCount > 0) {
      totalDays++;
      const rowMean = rowFiniteSum / rowFiniteCount;
      if (Math.abs(rowMean) <= eps) zeroDays++;
    }
  }

  if (globalCount === 0) return { ...NAN_STATS };

  const mean = globalSum / globalCount;
  const max = globalMax;
  const pctActive = totalDays === 0 ? NaN : ((totalDays - zeroDays) / totalDays) * 100;

  // Annualisation needs a day-span. With unparseable dates we fall back to
  // NaN — there's no honest way to scale a sum without a time axis.
  const span = dateSpanDays(dates);
  let annualTotal = NaN;
  if (Number.isFinite(span) && span > 0) {
    let annSum = 0;
    let annCount = 0;
    for (let s = 0; s < scenarioCount; s++) {
      if (perScenarioFinite[s] === 0) continue;
      annSum += (perScenarioSum[s] * DAYS_PER_YEAR) / span;
      annCount++;
    }
    annualTotal = annCount === 0 ? NaN : annSum / annCount;
  }

  return { mean, max, zeroDays, totalDays, pctActive, annualTotal };
}

// Pretty-print a stat value with sane precision for the small stats strip in
// the Results tab. Tight number budget — three slots per metric — so we avoid
// trailing zeros and switch to exponential outside [1e-3, 1e6].
export function formatStat(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// Pretty-print a percentage in 0..100 to one decimal place. NaN → "—" so the
// UI never renders "NaN%" to the user.
export function formatPct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 99.95) return "100%";
  if (v <= 0.05) return "0%";
  return `${v.toFixed(1)}%`;
}

// Traffic-light severity for the zero-flow analyzer (T1.3). Thresholds are
// fixed by the spec — ≥30 days zero = critical, ≥10 = warn, else ok. Kept
// here (not in the component) because the same thresholds will likely drive
// the canvas-side dot rendering once the analyzer ships.
//
// Operationally, 30 consecutive days of zero flow on an Output node almost
// always indicates a real problem (orphan branch, licence cap, miswired
// cost). 10 days is a softer flag — sometimes legitimate, often worth a look.
// Below 10 we treat as noise; intermittent zero days are common in seasonal
// flow models.
export type ZeroFlowSeverity = "critical" | "warn" | "ok";

export const ZERO_FLOW_CRITICAL_DAYS = 30;
export const ZERO_FLOW_WARN_DAYS = 10;

export function severityForZeroDays(zeroDays: number): ZeroFlowSeverity {
  if (!Number.isFinite(zeroDays) || zeroDays < 0) return "ok";
  if (zeroDays >= ZERO_FLOW_CRITICAL_DAYS) return "critical";
  if (zeroDays >= ZERO_FLOW_WARN_DAYS) return "warn";
  return "ok";
}

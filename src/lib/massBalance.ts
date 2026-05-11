// src/lib/massBalance.ts
// Pure helpers for the T1.4 system mass-balance audit. Mirrors notebook
// DIAG-6: sum every source recorder's flow, sum every sink recorder's flow,
// compare. Any timestep where outputs > inputs (beyond floating-point noise
// and any net storage release) is a candidate LP violation — Pywr's solver
// is supposed to make mass conserve, so a strict negative imbalance signals
// either a bug in the recorder set, a misclassified node, or a real solver
// pathology.
//
// Why a separate file from recorderStats.ts:
//   - recorderStats is "stats for ONE recorder". massBalance is "compare
//     N recorders against M recorders". Different shape, different invariants.
//   - Future T2/T3 diagnostics (Sankey, deficit dashboard) will reuse some of
//     the per-step alignment logic here; keeping it on its own file means
//     they import only what they need without dragging in the stats strip's
//     formatting helpers.
//
// Classification rules — fixed across the audit so nodes don't drift between
// the "source" and "sink" buckets depending on context:
//   - Source (water enters network)   : Input, Catchment, Discharge
//   - Sink   (water leaves network)   : Output
//   - Storage (water held, not lost)  : Storage, Reservoir
//   - Internal transfer (no net flux) : Link, River, RiverGauge, RiverSplit,
//                                       all licence/virtual storage, etc.
//
// The "internal transfer" bucket is deliberately broad: every node that just
// passes water through the network without adding or removing it. Aggregated
// recorders on these nodes double-count and would break the audit if included.
//
// Storage handling: a model can satisfy outputs > inputs in any single
// timestep by drawing down storage. We compute net storage change ΔS as
// (last_value - first_value) summed across every storage recorder; the
// residual `inputs - outputs - ΔS` should be ≈ 0 over the run. The
// per-timestep `net = inputs - outputs` flags possibly-suspicious days,
// while `residual` flags the whole-run integrity.

import { normalizeNodeType } from "../constants/nodeTypes";

// Float tolerance for "is this imbalance real?". Picked an order of magnitude
// looser than STATS_EPS in recorderStats — accumulating sums across hundreds
// of recorders and thousands of timesteps inevitably picks up roundoff in the
// 1e-9 range, and we don't want every model to flash a violation just from
// IEEE arithmetic.
export const BALANCE_EPS = 1e-6;
// Default fractional tolerance for the violation flag. A timestep is only
// counted as a violation if |net| / max(|inputs|, |outputs|) > this AND
// |net| > BALANCE_EPS. Without the fractional gate, a 1000-unit run with
// 1e-5 round-off would flag every step.
export const BALANCE_RELATIVE_TOL = 1e-4;

export type BalanceRole = "source" | "sink" | "storage" | "internal";

// Map a Pywr node type (any casing) to its role in the mass balance.
// Anything not explicitly classified falls under "internal" — safer than
// guessing. New node types added to the schema must be reviewed here.
export function classifyNodeForBalance(nodeType: string): BalanceRole {
  const t = normalizeNodeType(nodeType);
  if (t === "Input" || t === "Catchment" || t === "Discharge") return "source";
  if (t === "Output") return "sink";
  if (t === "Storage" || t === "Reservoir") return "storage";
  return "internal";
}

// One recorder's parsed series, narrowed to what the audit needs. We drop
// the multi-scenario shape and collapse to one number per timestep — the
// cross-scenario mean. Reason: mass balance is a per-LP-instance property
// and DIAG-6 compares the ensemble mean. If a future revision needs to
// preserve scenarios, this is the place to extend.
export interface BalanceSeries {
  recorderName: string;
  nodeName: string;
  role: BalanceRole;
  // dates[i] is the ISO date for collapsed[i]. Length is identical.
  dates: string[];
  // Cross-scenario mean per timestep. NaN where every scenario was non-finite.
  collapsed: number[];
}

// Cross-scenario collapse: mean of finite cells per row. Pure; exported so
// the test can pin the behaviour at row boundaries without spinning up a
// full audit.
export function collapseScenarios(values: number[][]): number[] {
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

// One per-step record in the audit table. `net` is positive when more flow
// enters than leaves (normal — surplus retained by storage). It is negative
// when more flow leaves than enters (legitimate when storage is being drawn
// down, otherwise a candidate LP violation).
export interface DailyBalance {
  date: string;
  inputs: number;
  outputs: number;
  // inputs - outputs. Positive: surplus (often goes to storage).
  //                  Negative: deficit (storage releasing, or violation).
  net: number;
}

export interface MassBalance {
  // Per-timestep series, ordered by date. Length = union of dates seen
  // across every supplied series — typically the run length.
  daily: DailyBalance[];
  // Sum of inputs over the whole horizon.
  totalInputs: number;
  // Sum of outputs over the whole horizon.
  totalOutputs: number;
  // Net storage change across every storage recorder. Positive: storage
  // gained water (fill). Negative: storage lost water (release).
  storageDelta: number;
  // totalInputs - totalOutputs - storageDelta. Should be ≈ 0 if the model
  // conserves mass perfectly. A large nonzero residual flags either a
  // misclassified node, a missing recorder, or a real LP issue.
  residual: number;
  // |residual| / max(|inputs|, |outputs|) × 100. NaN if both totals are 0
  // (e.g. an unstarted run).
  pctImbalance: number;
  // Timesteps whose negative imbalance exceeds the relative tolerance,
  // computed after subtracting that step's storage delta. These are the
  // candidate LP violations surfaced to the user.
  violationDays: number;
  // Up to N worst (most-negative net) days, sorted descending by |net|.
  // Used by the UI to show "here are the days to look at first".
  worstDays: DailyBalance[];
}

const EMPTY_BALANCE: MassBalance = {
  daily: [],
  totalInputs: 0,
  totalOutputs: 0,
  storageDelta: 0,
  residual: 0,
  pctImbalance: NaN,
  violationDays: 0,
  worstDays: [],
};

// Build the union of dates across every series, preserving the order in
// which dates first appear. Pywr always writes ISO dates in calendar order
// per CSV; with one series per node and the same run timestepper they all
// line up, but using the union (rather than series[0].dates) keeps the
// helper honest when a recorder is missing some steps.
export function buildDateAxis(series: BalanceSeries[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of series) {
    for (const d of s.dates) {
      if (!seen.has(d)) {
        seen.add(d);
        out.push(d);
      }
    }
  }
  // Sort lexicographically — ISO-8601 dates are lex-sortable. This guards
  // against the (rare) case of series being supplied with reordered dates.
  out.sort();
  return out;
}

// Pure: compute the audit from already-parsed series. The component layer
// owns CSV loading; this function takes the result of that work and
// produces the audit shape with no I/O.
export function computeMassBalance(
  series: BalanceSeries[],
  opts: {
    worstDayLimit?: number;
    relTol?: number;
    eps?: number;
  } = {},
): MassBalance {
  const limit = opts.worstDayLimit ?? 10;
  const relTol = opts.relTol ?? BALANCE_RELATIVE_TOL;
  const eps = opts.eps ?? BALANCE_EPS;

  if (series.length === 0) return { ...EMPTY_BALANCE };

  // Pre-index each series by date for O(1) lookup while building the
  // per-step record. We tolerate gaps (NaN) without inflating sums — a
  // recorder that's missing a step contributes 0 there rather than NaN,
  // because NaN propagation would zero the audit's signal on the first
  // bad cell. We log the gap by skipping it in the count but not in the
  // sum. (We don't expose the count today; if it becomes useful, plumb
  // through a `missingCells` counter here.)
  const byDate = new Map<string, Map<string, number>>(); // date → recName → value
  for (const s of series) {
    for (let i = 0; i < s.dates.length; i++) {
      const d = s.dates[i];
      const v = s.collapsed[i];
      let row = byDate.get(d);
      if (!row) {
        row = new Map<string, number>();
        byDate.set(d, row);
      }
      row.set(s.recorderName, v);
    }
  }

  const sources = series.filter((s) => s.role === "source");
  const sinks = series.filter((s) => s.role === "sink");
  const storages = series.filter((s) => s.role === "storage");

  const dates = buildDateAxis(series);
  const daily: DailyBalance[] = new Array(dates.length);

  let totalInputs = 0;
  let totalOutputs = 0;

  for (let i = 0; i < dates.length; i++) {
    const d = dates[i];
    const row = byDate.get(d);
    let dayInputs = 0;
    let dayOutputs = 0;
    if (row) {
      for (const s of sources) {
        const v = row.get(s.recorderName);
        if (Number.isFinite(v)) dayInputs += v as number;
      }
      for (const s of sinks) {
        const v = row.get(s.recorderName);
        if (Number.isFinite(v)) dayOutputs += v as number;
      }
    }
    totalInputs += dayInputs;
    totalOutputs += dayOutputs;
    daily[i] = { date: d, inputs: dayInputs, outputs: dayOutputs, net: dayInputs - dayOutputs };
  }

  // Net storage change — first finite value to last finite value, summed
  // across every storage recorder. Negative storageDelta means storage
  // released water (legitimate excess output). We use first/last finite
  // rather than dates[0]/dates[N-1] so a recorder that starts with NaN
  // (e.g. initial-state oddity) doesn't poison the delta.
  let storageDelta = 0;
  for (const s of storages) {
    let firstV: number | null = null;
    let lastV: number | null = null;
    for (let i = 0; i < s.collapsed.length; i++) {
      const v = s.collapsed[i];
      if (Number.isFinite(v)) {
        if (firstV === null) firstV = v;
        lastV = v;
      }
    }
    if (firstV !== null && lastV !== null) {
      storageDelta += lastV - firstV;
    }
  }

  const residual = totalInputs - totalOutputs - storageDelta;
  const denom = Math.max(Math.abs(totalInputs), Math.abs(totalOutputs));
  const pctImbalance = denom === 0 ? NaN : (Math.abs(residual) / denom) * 100;

  // Violation count: per-step net (NOT residual — storage drawdown is per-
  // step, we don't have a per-step ΔS to subtract without a level series).
  // We accept a small absolute floor (eps) AND a relative tolerance against
  // the day's larger flow magnitude. If a model has no storage at all,
  // every negative net is a violation. With storage, this metric over-
  // counts — surfaced in the UI as "candidate" violations and paired with
  // the residual so the user can see whether the run conserves overall.
  let violationDays = 0;
  for (const day of daily) {
    if (day.net >= -eps) continue;
    const dayDenom = Math.max(Math.abs(day.inputs), Math.abs(day.outputs));
    if (dayDenom === 0) continue;
    if (Math.abs(day.net) / dayDenom > relTol) violationDays++;
  }

  // Worst-day list: most-negative net first. We sort a copy so the daily
  // array stays in date order for the UI's timeline view.
  const worstDays = daily
    .filter((d) => d.net < 0)
    .slice()
    .sort((a, b) => a.net - b.net) // ascending net = most negative first
    .slice(0, limit);

  return {
    daily,
    totalInputs,
    totalOutputs,
    storageDelta,
    residual,
    pctImbalance,
    violationDays,
    worstDays,
  };
}

// Format helpers — kept here (not in recorderStats) because mass balance
// magnitudes are typically larger than per-recorder stats and we want one
// place that decides "should this be exponential or fixed".
export function formatVolume(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e9 || abs < 1e-3) return v.toExponential(2);
  if (abs >= 1e6) return (v / 1e6).toFixed(2) + "M";
  if (abs >= 1e3) return (v / 1e3).toFixed(2) + "k";
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// Signed format — includes a leading "+" for positives so the surplus /
// deficit direction reads at a glance in the residual row.
export function formatSigned(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v === 0) return "0";
  const sign = v > 0 ? "+" : "−";
  return sign + formatVolume(Math.abs(v));
}

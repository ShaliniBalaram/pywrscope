// src/test/reliability.test.ts
// Pins the per-Output reliability math used by the T2.7 dashboard. The
// component layer is a league table; correctness lives here.

import { describe, it, expect } from "vitest";
import {
  buildConcurrentFailureMatrix,
  computeDeficitIndicator,
  computeReliability,
  DEFAULT_MIN_EVENT_DAYS,
  DEFICIT_SENTINEL_FAIL,
  DEFICIT_SENTINEL_MET,
  DEFICIT_SENTINEL_NO_DATA,
  extractDeficitEvents,
  extractDemand,
  formatReliability,
  RELIABILITY_CRITICAL_PCT,
  RELIABILITY_TOL,
  RELIABILITY_WARN_PCT,
  severityForReliability,
  summariseEvents,
} from "../lib/reliability";

function dailyDates(start: string, count: number): string[] {
  const out: string[] = [];
  const t0 = Date.parse(start);
  for (let i = 0; i < count; i++) {
    const d = new Date(t0 + i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

describe("extractDemand", () => {
  it("returns 'numeric' with the value when max_flow is a finite number", () => {
    expect(extractDemand(5)).toEqual({ kind: "numeric", value: 5, paramName: "" });
    expect(extractDemand(0)).toEqual({ kind: "numeric", value: 0, paramName: "" });
  });
  it("returns 'parameter' when max_flow is a non-empty string", () => {
    expect(extractDemand("demand_profile")).toEqual({
      kind: "parameter", value: NaN, paramName: "demand_profile",
    });
  });
  it("returns 'unconstrained' for null / undefined / empty string", () => {
    expect(extractDemand(undefined).kind).toBe("unconstrained");
    expect(extractDemand(null).kind).toBe("unconstrained");
    expect(extractDemand("").kind).toBe("unconstrained");
    expect(extractDemand(NaN).kind).toBe("unconstrained");
    expect(extractDemand(Infinity).kind).toBe("unconstrained");
  });
});

describe("computeReliability — clean cases", () => {
  it("returns 100% reliability when supply meets demand every day", () => {
    const r = computeReliability(
      Array.from({ length: 10 }, () => [10]),
      10,
    );
    expect(r.totalDays).toBe(10);
    expect(r.deficitDays).toBe(0);
    expect(r.pctReliability).toBe(100);
    expect(r.longestDeficitRun).toBe(0);
    expect(r.totalShortfall).toBe(0);
    expect(Number.isNaN(r.meanShortfall)).toBe(true);
  });

  it("returns 0% reliability when supply is always zero", () => {
    const r = computeReliability(
      Array.from({ length: 5 }, () => [0]),
      10,
    );
    expect(r.deficitDays).toBe(5);
    expect(r.pctReliability).toBe(0);
    expect(r.longestDeficitRun).toBe(5);
    expect(r.totalShortfall).toBe(50);
    expect(r.meanShortfall).toBe(10);
  });

  it("counts a mid-period deficit as exactly the affected days", () => {
    // 10 days: full for 5, zero for 3, full for 2. Deficit run = 3.
    const flow = [10, 10, 10, 10, 10, 0, 0, 0, 10, 10].map((v) => [v]);
    const r = computeReliability(flow, 10);
    expect(r.deficitDays).toBe(3);
    expect(r.longestDeficitRun).toBe(3);
    expect(r.pctReliability).toBe(70);
    expect(r.totalShortfall).toBe(30);
  });
});

describe("computeReliability — tolerance", () => {
  it("treats a 1% under-delivery as 'met' with default tolerance", () => {
    // Default tol = 1%. Demand=100, flow=99.5 → within band → no deficit.
    const r = computeReliability(
      Array.from({ length: 5 }, () => [99.5]),
      100,
    );
    expect(r.deficitDays).toBe(0);
    expect(r.pctReliability).toBe(100);
  });

  it("flags a 2% under-delivery as a deficit", () => {
    const r = computeReliability(
      Array.from({ length: 5 }, () => [98]),
      100,
    );
    expect(r.deficitDays).toBe(5);
  });

  it("respects a custom looser tolerance", () => {
    const r = computeReliability(
      Array.from({ length: 5 }, () => [90]),
      100,
      { tolerance: 0.15 },
    );
    expect(r.deficitDays).toBe(0); // 90 ≥ 100 × (1 - 0.15) = 85
  });
});

describe("computeReliability — longest run", () => {
  it("returns the maximum consecutive-deficit length, not the latest", () => {
    // Two deficit runs: length 4 then length 2. Longest = 4.
    const flow = [0, 0, 0, 0, 10, 10, 0, 0, 10, 10].map((v) => [v]);
    const r = computeReliability(flow, 10);
    expect(r.longestDeficitRun).toBe(4);
  });

  it("a NaN cell breaks the current run without contributing to the count", () => {
    // Pattern: deficit, deficit, NaN, deficit → two runs of length 2 and 1.
    // NaN is excluded from totalDays AND breaks the run, so the count is
    // 3 deficit days out of 3 total — but longestDeficitRun stays at 2.
    const flow = [[0], [0], [NaN], [0]];
    const r = computeReliability(flow, 10);
    expect(r.totalDays).toBe(3); // NaN row skipped
    expect(r.deficitDays).toBe(3);
    expect(r.longestDeficitRun).toBe(2);
  });
});

describe("computeReliability — multi-scenario", () => {
  it("uses the cross-scenario mean per timestep", () => {
    // 5 days, 2 scenarios. Day means: 10, 10, 0, 10, 10. → 1 deficit.
    const flow = [
      [10, 10],
      [10, 10],
      [0, 0],
      [10, 10],
      [10, 10],
    ];
    const r = computeReliability(flow, 10);
    expect(r.deficitDays).toBe(1);
  });

  it("partial scenario coverage uses the finite mean", () => {
    // Day 2: [NaN, 5] → mean 5 → deficit against demand 10.
    const flow = [[NaN, 5]];
    const r = computeReliability(flow, 10);
    expect(r.totalDays).toBe(1);
    expect(r.deficitDays).toBe(1);
    expect(r.totalShortfall).toBe(5);
  });
});

describe("computeReliability — edge cases", () => {
  it("returns NaN-stats for a non-positive demand (unconstrained sentinel)", () => {
    const r = computeReliability([[1], [2]], 0);
    expect(Number.isNaN(r.pctReliability)).toBe(true);
    expect(r.totalDays).toBe(0);
  });

  it("returns NaN-stats for a NaN demand (parameter reference)", () => {
    const r = computeReliability([[1], [2]], NaN);
    expect(Number.isNaN(r.pctReliability)).toBe(true);
  });

  it("returns NaN-stats for an empty values input", () => {
    const r = computeReliability([], 10);
    expect(r.totalDays).toBe(0);
    expect(Number.isNaN(r.pctReliability)).toBe(true);
  });

  it("pins the public tolerance constant", () => {
    expect(RELIABILITY_TOL).toBe(0.01);
  });
});

describe("severityForReliability", () => {
  it("returns 'critical' below the critical threshold", () => {
    expect(severityForReliability(0)).toBe("critical");
    expect(severityForReliability(RELIABILITY_CRITICAL_PCT - 0.1)).toBe("critical");
  });
  it("returns 'warn' in the middle band", () => {
    expect(severityForReliability(RELIABILITY_CRITICAL_PCT)).toBe("warn");
    expect(severityForReliability(85)).toBe("warn");
    expect(severityForReliability(RELIABILITY_WARN_PCT - 0.1)).toBe("warn");
  });
  it("returns 'ok' at or above the ok threshold", () => {
    expect(severityForReliability(RELIABILITY_WARN_PCT)).toBe("ok");
    expect(severityForReliability(100)).toBe("ok");
  });
  it("treats NaN as 'ok' so unknown rows don't paint red", () => {
    expect(severityForReliability(NaN)).toBe("ok");
  });
  it("pins the spec thresholds", () => {
    expect(RELIABILITY_CRITICAL_PCT).toBe(80);
    expect(RELIABILITY_WARN_PCT).toBe(95);
  });
});

describe("formatReliability", () => {
  it("renders mid-range to one decimal", () => {
    expect(formatReliability(87.234)).toBe("87.2%");
  });
  it("rounds extremes to clean 0% / 100%", () => {
    expect(formatReliability(99.99)).toBe("100%");
    expect(formatReliability(0.001)).toBe("0%");
  });
  it("renders NaN as em-dash", () => {
    expect(formatReliability(NaN)).toBe("—");
  });
});

describe("extractDeficitEvents", () => {
  it("returns no events when supply meets demand every day", () => {
    const values = Array.from({ length: 10 }, () => [10]);
    const events = extractDeficitEvents(values, dailyDates("2024-01-01", 10), 10);
    expect(events).toEqual([]);
  });

  it("emits one event for a single deficit run that exceeds minDuration", () => {
    // 14 days, demand=10. Deficit days 5..11 (7 in a row) → one event.
    const flow = [10, 10, 10, 10, 10, 0, 0, 0, 0, 0, 0, 0, 10, 10].map((v) => [v]);
    const events = extractDeficitEvents(flow, dailyDates("2024-01-01", 14), 10);
    expect(events.length).toBe(1);
    expect(events[0].startIndex).toBe(5);
    expect(events[0].endIndex).toBe(11);
    expect(events[0].duration).toBe(7);
    expect(events[0].startDate).toBe("2024-01-06");
    expect(events[0].endDate).toBe("2024-01-12");
    expect(events[0].totalShortfall).toBe(70);
    expect(events[0].peakShortfall).toBe(10);
    expect(events[0].meanShortfall).toBeCloseTo(10, 6);
  });

  it("filters out short events below the default minimum duration (7 days)", () => {
    // A 3-day deficit run shouldn't make it past the default filter.
    const flow = [10, 10, 0, 0, 0, 10, 10, 10, 10, 10].map((v) => [v]);
    expect(extractDeficitEvents(flow, dailyDates("2024-01-01", 10), 10)).toEqual([]);
  });

  it("respects a custom minDuration", () => {
    const flow = [10, 0, 0, 0, 10, 10].map((v) => [v]);
    const events = extractDeficitEvents(flow, dailyDates("2024-01-01", 6), 10, { minDuration: 3 });
    expect(events.length).toBe(1);
    expect(events[0].duration).toBe(3);
  });

  it("separates two adjacent events split by a recovery day", () => {
    // 0,0,0,0,0,0,0 — recover — 0,0,0,0,0,0,0 → two 7-day events.
    const flow = [
      0, 0, 0, 0, 0, 0, 0,
      10,
      0, 0, 0, 0, 0, 0, 0,
    ].map((v) => [v]);
    const events = extractDeficitEvents(flow, dailyDates("2024-01-01", 15), 10);
    expect(events.length).toBe(2);
    expect(events[0].duration).toBe(7);
    expect(events[1].duration).toBe(7);
    expect(events[1].startIndex).toBe(8);
  });

  it("breaks a run on a NaN cell and doesn't carry shortfall across the gap", () => {
    // Days: 0×4, NaN, 0×4. With minDuration=4 → two 4-day events.
    const flow = [
      [0], [0], [0], [0],
      [NaN],
      [0], [0], [0], [0],
    ];
    const events = extractDeficitEvents(flow, dailyDates("2024-01-01", 9), 10, { minDuration: 4 });
    expect(events.length).toBe(2);
    expect(events[0].duration).toBe(4);
    expect(events[1].duration).toBe(4);
  });

  it("returns [] when demand is non-positive or non-finite", () => {
    const flow = [[0]];
    const dates = ["2024-01-01"];
    expect(extractDeficitEvents(flow, dates, 0)).toEqual([]);
    expect(extractDeficitEvents(flow, dates, NaN)).toEqual([]);
    expect(extractDeficitEvents(flow, dates, -1)).toEqual([]);
  });

  it("returns [] when dates and values are mis-aligned", () => {
    expect(extractDeficitEvents([[1], [2]], ["only-one-date"], 5)).toEqual([]);
  });

  it("uses cross-scenario mean before threshold comparison", () => {
    // Day means: 10, 10, 0, 0, 0, 0, 0, 0, 0, 10. Run is days 2..8 (7).
    const flow = [
      [10, 10], [10, 10],
      [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0],
      [10, 10],
    ];
    const events = extractDeficitEvents(flow, dailyDates("2024-01-01", 10), 10);
    expect(events.length).toBe(1);
    expect(events[0].duration).toBe(7);
  });

  it("pins the default minimum-event days", () => {
    expect(DEFAULT_MIN_EVENT_DAYS).toBe(7);
  });
});

describe("summariseEvents", () => {
  it("returns zero-stats for an empty list", () => {
    const s = summariseEvents([]);
    expect(s.count).toBe(0);
    expect(Number.isNaN(s.meanDuration)).toBe(true);
    expect(s.maxDuration).toBe(0);
    expect(s.totalShortfall).toBe(0);
  });

  it("computes count / mean / max / total across events", () => {
    const events = extractDeficitEvents(
      [
        ...Array(3).fill([0]), // event 1: 3-day
        [10], [10],
        ...Array(5).fill([0]), // event 2: 5-day
      ],
      dailyDates("2024-01-01", 10),
      10,
      { minDuration: 1 },
    );
    expect(events.length).toBe(2);
    const s = summariseEvents(events);
    expect(s.count).toBe(2);
    expect(s.maxDuration).toBe(5);
    expect(s.meanDuration).toBe(4);
    expect(s.totalShortfall).toBe(80); // (3+5)×10
  });
});

// ---------------------------------------------------------------------------
// T3.9 — computeDeficitIndicator + buildConcurrentFailureMatrix
// ---------------------------------------------------------------------------

describe("computeDeficitIndicator", () => {
  it("emits 1 for deficit, 0 for met, -1 for no-data", () => {
    const ind = computeDeficitIndicator(
      [[10], [0], [NaN], [9.9], [5]],
      10,
    );
    // Day 0: met (10 ≥ 9.9 threshold) → 0
    // Day 1: deficit (0 < 9.9) → 1
    // Day 2: NaN → -1
    // Day 3: 9.9 == threshold → met (the threshold is INCLUSIVE-met because
    //        the test uses `v < threshold`).
    // Day 4: 5 < 9.9 → deficit
    expect(Array.from(ind)).toEqual([
      DEFICIT_SENTINEL_MET,
      DEFICIT_SENTINEL_FAIL,
      DEFICIT_SENTINEL_NO_DATA,
      DEFICIT_SENTINEL_MET,
      DEFICIT_SENTINEL_FAIL,
    ]);
  });

  it("collapses scenarios via mean before thresholding", () => {
    // Day 0 mean = 5 → deficit. Day 1 mean = 10 → met.
    const ind = computeDeficitIndicator([[0, 10], [10, 10]], 10);
    expect(Array.from(ind)).toEqual([DEFICIT_SENTINEL_FAIL, DEFICIT_SENTINEL_MET]);
  });

  it("returns an empty array for non-positive or NaN demand", () => {
    expect(computeDeficitIndicator([[1]], 0).length).toBe(0);
    expect(computeDeficitIndicator([[1]], NaN).length).toBe(0);
    expect(computeDeficitIndicator([[1]], -5).length).toBe(0);
  });

  it("respects a looser custom tolerance", () => {
    // demand 100, tolerance 0.1 → threshold 90. 91 is met, 89 is deficit.
    const ind = computeDeficitIndicator([[91], [89]], 100, { tolerance: 0.1 });
    expect(Array.from(ind)).toEqual([DEFICIT_SENTINEL_MET, DEFICIT_SENTINEL_FAIL]);
  });
});

describe("buildConcurrentFailureMatrix", () => {
  const dates = dailyDates("2024-01-01", 5);

  function row(name: string, indicator: number[]) {
    return {
      nodeName: name,
      recorderName: `rec_${name}`,
      dates,
      indicator: Int8Array.from(indicator),
    };
  }

  it("returns an empty matrix for no rows", () => {
    const m = buildConcurrentFailureMatrix([]);
    expect(m.nodes).toEqual([]);
    expect(m.dates).toEqual([]);
    expect(m.perDayCount).toEqual([]);
    expect(m.worstDayIndex).toBe(-1);
    expect(m.peakConcurrent).toBe(0);
  });

  it("counts concurrent failures column-wise and ranks rows by total", () => {
    const m = buildConcurrentFailureMatrix([
      row("A", [1, 1, 0, 0, 0]), // 2 deficit days
      row("B", [1, 1, 1, 0, 0]), // 3 deficit days — worst
      row("C", [0, 0, 0, 0, 0]), // 0 deficit days
    ]);
    expect(m.nodes).toEqual(["B", "A", "C"]); // sorted desc by totals, ties by name
    expect(m.perNodeTotals).toEqual([3, 2, 0]);
    expect(m.perDayCount).toEqual([2, 2, 1, 0, 0]);
    // Worst day is day 0 or day 1 (both 2). Sort picks the first occurrence
    // because we use strict > on update.
    expect(m.worstDayIndex).toBe(0);
    expect(m.peakConcurrent).toBe(2);
    expect(m.droppedRows).toBe(0);
  });

  it("ignores no-data cells when summing the per-day count", () => {
    const m = buildConcurrentFailureMatrix([
      row("A", [-1, 1, 0, 0, 0]),
      row("B", [1, -1, 0, 0, 0]),
    ]);
    // Day 0: A is no-data (not counted) + B is deficit → 1
    // Day 1: A is deficit + B is no-data → 1
    expect(m.perDayCount).toEqual([1, 1, 0, 0, 0]);
  });

  it("drops rows whose dates don't align with the longest reference timeline", () => {
    const longRow = row("Long", [0, 0, 0, 0, 0]); // 5-day timeline → reference
    const shortRow = {
      nodeName: "Short",
      recorderName: "rec_short",
      dates: dailyDates("2024-01-01", 3),
      indicator: Int8Array.from([1, 1, 1]),
    };
    const mismatchedRow = {
      nodeName: "Mismatch",
      recorderName: "rec_mismatch",
      dates: dailyDates("2099-01-01", 5),
      indicator: Int8Array.from([1, 1, 1, 1, 1]),
    };
    const m = buildConcurrentFailureMatrix([longRow, shortRow, mismatchedRow]);
    expect(m.nodes).toEqual(["Long"]);
    expect(m.droppedRows).toBe(2);
    expect(m.dates).toEqual(longRow.dates);
  });

  it("ties on total break alphabetically by node name", () => {
    const m = buildConcurrentFailureMatrix([
      row("Beta", [1, 1, 0, 0, 0]),
      row("Alpha", [1, 1, 0, 0, 0]),
    ]);
    expect(m.nodes).toEqual(["Alpha", "Beta"]);
  });

  it("uses the longest-length row as the reference timeline", () => {
    // Two rows of length 5 + a length-3 outlier. The 5-day rows align so
    // both are kept; the 3-day row is dropped.
    const m = buildConcurrentFailureMatrix([
      row("A", [1, 0, 0, 0, 0]),
      row("B", [0, 1, 0, 0, 0]),
      {
        nodeName: "Stub",
        recorderName: "stub",
        dates: dailyDates("2024-01-01", 3),
        indicator: Int8Array.from([1, 1, 1]),
      },
    ]);
    expect(m.dates.length).toBe(5);
    expect(m.droppedRows).toBe(1);
  });
});

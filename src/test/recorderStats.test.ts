// src/test/recorderStats.test.ts
// Pins down the per-recorder statistics used by the T1.2 stats table.
// The component layer is just presentation; correctness lives here.

import { describe, it, expect } from "vitest";
import {
  computeStats,
  dateSpanDays,
  formatPct,
  formatStat,
  parseIsoDateMs,
  severityForZeroDays,
  STATS_EPS,
  ZERO_FLOW_CRITICAL_DAYS,
  ZERO_FLOW_WARN_DAYS,
} from "../lib/recorderStats";

function dailyDates(start: string, count: number): string[] {
  const out: string[] = [];
  const t0 = Date.parse(start);
  for (let i = 0; i < count; i++) {
    const d = new Date(t0 + i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

describe("parseIsoDateMs", () => {
  it("parses YYYY-MM-DD ISO strings", () => {
    expect(parseIsoDateMs("2024-01-01")).toBe(Date.UTC(2024, 0, 1));
  });
  it("returns NaN for unparseable inputs", () => {
    expect(Number.isNaN(parseIsoDateMs(""))).toBe(true);
    expect(Number.isNaN(parseIsoDateMs("not a date"))).toBe(true);
  });
});

describe("dateSpanDays", () => {
  it("returns inclusive day-count between first and last date", () => {
    // Jan 1 → Jan 5 inclusive = 5 days
    expect(dateSpanDays(["2024-01-01", "2024-01-02", "2024-01-05"])).toBe(5);
  });
  it("counts a full year correctly (365 + 1 leap day in 2024 = 366)", () => {
    expect(dateSpanDays(["2024-01-01", "2024-12-31"])).toBe(366);
  });
  it("returns NaN with fewer than two dates", () => {
    expect(Number.isNaN(dateSpanDays([]))).toBe(true);
    expect(Number.isNaN(dateSpanDays(["2024-01-01"]))).toBe(true);
  });
  it("returns NaN when bounds are unparseable", () => {
    expect(Number.isNaN(dateSpanDays(["bad", "2024-01-02"]))).toBe(true);
    expect(Number.isNaN(dateSpanDays(["2024-01-01", "bad"]))).toBe(true);
  });
});

describe("computeStats — single scenario", () => {
  it("computes mean/max/zeroDays/pctActive on a simple 3-day series", () => {
    const stats = computeStats(
      [[5], [0], [10]],
      dailyDates("2024-01-01", 3),
    );
    expect(stats.mean).toBeCloseTo(5, 6);
    expect(stats.max).toBe(10);
    expect(stats.zeroDays).toBe(1);
    expect(stats.totalDays).toBe(3);
    expect(stats.pctActive).toBeCloseTo((2 / 3) * 100, 6);
  });

  it("annualises a one-year daily series so annualTotal ≈ sum", () => {
    // 365 days of value 1 → sum=365. Span = 365 days. annual = 365 * 365.25/365 ≈ 365.25
    const days = 365;
    const stats = computeStats(
      Array.from({ length: days }, () => [1]),
      dailyDates("2023-01-01", days),
    );
    expect(stats.annualTotal).toBeCloseTo(365.25, 1);
  });

  it("annualises a sub-year series by scaling sum up to 365.25 days", () => {
    // 30 days of value 2 → sum=60. annual = 60 × 365.25/30 = 730.5
    const stats = computeStats(
      Array.from({ length: 30 }, () => [2]),
      dailyDates("2024-01-01", 30),
    );
    expect(stats.annualTotal).toBeCloseTo(730.5, 2);
  });

  it("returns NaN annualTotal when dates can't be parsed", () => {
    const stats = computeStats([[1], [2], [3]], ["x", "y", "z"]);
    expect(Number.isNaN(stats.annualTotal)).toBe(true);
    // Other stats still work — date failure shouldn't poison the whole table.
    expect(stats.mean).toBe(2);
    expect(stats.max).toBe(3);
  });
});

describe("computeStats — multi-scenario", () => {
  it("averages across all scenario × timestep cells for mean", () => {
    // 2 days × 3 scenarios
    const stats = computeStats(
      [
        [1, 2, 3],
        [4, 5, 6],
      ],
      dailyDates("2024-01-01", 2),
    );
    // (1+2+3+4+5+6)/6 = 3.5
    expect(stats.mean).toBeCloseTo(3.5, 6);
    expect(stats.max).toBe(6);
  });

  it("zeroDays uses the cross-scenario mean per row", () => {
    // Day 1: mean = 0 → zero day. Day 2: mean = 1 → active.
    const stats = computeStats(
      [
        [-1, 0, 1], // mean = 0
        [1, 1, 1], // mean = 1
      ],
      dailyDates("2024-01-01", 2),
    );
    expect(stats.zeroDays).toBe(1);
    expect(stats.totalDays).toBe(2);
    expect(stats.pctActive).toBe(50);
  });

  it("averages per-scenario annualised sums (not the global pool)", () => {
    // 10 days, 2 scenarios. Scenario 0: sum=10, scenario 1: sum=20.
    // annual = 365.25/10 × ((10+20)/2) = 36.525 × 15 = 547.875
    const stats = computeStats(
      Array.from({ length: 10 }, (_, i) => [i < 10 ? 1 : 0, i < 10 ? 2 : 0]),
      dailyDates("2024-01-01", 10),
    );
    expect(stats.annualTotal).toBeCloseTo(547.875, 2);
  });
});

describe("computeStats — edge cases", () => {
  it("returns NaN-stats for an empty series", () => {
    const stats = computeStats([], []);
    expect(Number.isNaN(stats.mean)).toBe(true);
    expect(Number.isNaN(stats.max)).toBe(true);
    expect(stats.totalDays).toBe(0);
    expect(stats.zeroDays).toBe(0);
    expect(Number.isNaN(stats.pctActive)).toBe(true);
    expect(Number.isNaN(stats.annualTotal)).toBe(true);
  });

  it("skips NaN cells but still counts a row as a day if any cell is finite", () => {
    const stats = computeStats(
      [
        [1, NaN], // one finite cell — still a day
        [NaN, NaN], // no finite cells — not counted as a day
        [0, 0], // both finite, zero day
      ],
      dailyDates("2024-01-01", 3),
    );
    expect(stats.totalDays).toBe(2);
    expect(stats.zeroDays).toBe(1);
    expect(stats.mean).toBeCloseTo(1 / 3, 6); // (1 + 0 + 0) / 3
  });

  it("respects a non-default epsilon for zeroDays", () => {
    // With default eps (1e-9), 1e-6 is "active". With eps=1e-3, it's zero.
    const values = [[1e-6], [1e-6], [1e-6]];
    const dates = dailyDates("2024-01-01", 3);
    expect(computeStats(values, dates).zeroDays).toBe(0);
    expect(computeStats(values, dates, { eps: 1e-3 }).zeroDays).toBe(3);
  });

  it("returns NaN-stats when every cell is non-finite", () => {
    const stats = computeStats(
      [[NaN, NaN], [NaN, NaN]],
      dailyDates("2024-01-01", 2),
    );
    expect(Number.isNaN(stats.mean)).toBe(true);
    expect(stats.totalDays).toBe(0);
  });

  it("STATS_EPS is the shared 1e-9 threshold used by ResultsTab", () => {
    // Pinning the value so a future change here forces a review of every
    // call site that imports it.
    expect(STATS_EPS).toBe(1e-9);
  });
});

describe("formatStat", () => {
  it("uses fixed notation for medium magnitudes", () => {
    expect(formatStat(5.234)).toBe("5.23");
    expect(formatStat(123)).toBe("123");
    expect(formatStat(0.001)).toBe("0.001");
  });
  it("uses exponential notation for very small or very large", () => {
    expect(formatStat(1e7)).toMatch(/e/);
    expect(formatStat(1e-5)).toMatch(/e/);
  });
  it("renders zero plainly and NaN as em-dash", () => {
    expect(formatStat(0)).toBe("0");
    expect(formatStat(NaN)).toBe("—");
    expect(formatStat(Infinity)).toBe("—");
  });
});

describe("formatPct", () => {
  it("renders mid-range percentages to one decimal", () => {
    expect(formatPct(42.345)).toBe("42.3%");
  });
  it("rounds the extremes to clean 0% / 100% strings", () => {
    expect(formatPct(99.99)).toBe("100%");
    expect(formatPct(0.001)).toBe("0%");
  });
  it("renders NaN as em-dash, never 'NaN%'", () => {
    expect(formatPct(NaN)).toBe("—");
  });
});

describe("severityForZeroDays", () => {
  it("returns 'ok' for zero-day counts below the warn threshold", () => {
    expect(severityForZeroDays(0)).toBe("ok");
    expect(severityForZeroDays(9)).toBe("ok");
  });
  it("returns 'warn' at the warn threshold", () => {
    expect(severityForZeroDays(ZERO_FLOW_WARN_DAYS)).toBe("warn");
    expect(severityForZeroDays(15)).toBe("warn");
    expect(severityForZeroDays(ZERO_FLOW_CRITICAL_DAYS - 1)).toBe("warn");
  });
  it("returns 'critical' at the critical threshold", () => {
    expect(severityForZeroDays(ZERO_FLOW_CRITICAL_DAYS)).toBe("critical");
    expect(severityForZeroDays(365)).toBe("critical");
  });
  it("treats negative / non-finite inputs as 'ok' so a bad upstream value never paints red", () => {
    expect(severityForZeroDays(-1)).toBe("ok");
    expect(severityForZeroDays(NaN)).toBe("ok");
    // Infinity is non-finite too — defensive treatment as ok rather than
    // critical, because Infinity here would mean upstream broke, not that
    // every day was zero. Better to under-flag than over-flag.
    expect(severityForZeroDays(Infinity)).toBe("ok");
  });
  it("pins the spec thresholds (≥30 critical, ≥10 warn)", () => {
    // If these constants change in the future, the call sites that hard-code
    // colors against them must be re-reviewed.
    expect(ZERO_FLOW_CRITICAL_DAYS).toBe(30);
    expect(ZERO_FLOW_WARN_DAYS).toBe(10);
  });
});

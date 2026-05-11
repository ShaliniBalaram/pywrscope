// src/test/flowDuration.test.ts
// Pins the FDC plotting-position formulas, sort behaviour, NaN handling,
// and exceedance lookup. Presentation lives in the component; correctness
// of "what flow is exceeded X% of the time" lives here.

import { describe, it, expect } from "vitest";
import {
  computeFlowDuration,
  flowAtExceedance,
  plottingPosition,
  STANDARD_EXCEEDANCE_QUANTILES,
  type FlowDurationPoint,
} from "../lib/flowDuration";

describe("plottingPosition", () => {
  it("returns Weibull i/(N+1) by default", () => {
    // Rank 1 of 4 → 1/5 = 0.2
    expect(plottingPosition(1, 4)).toBeCloseTo(0.2, 6);
    expect(plottingPosition(4, 4)).toBeCloseTo(0.8, 6);
  });
  it("supports Gringorten and Cunnane formulas", () => {
    // Gringorten: (1 - 0.44)/(4 + 0.12) = 0.56/4.12 ≈ 0.1359
    expect(plottingPosition(1, 4, "gringorten")).toBeCloseTo(0.56 / 4.12, 6);
    // Cunnane: (1 - 0.4)/(4 + 0.2) = 0.6/4.2 ≈ 0.1429
    expect(plottingPosition(1, 4, "cunnane")).toBeCloseTo(0.6 / 4.2, 6);
  });
  it("returns NaN for empty population", () => {
    expect(Number.isNaN(plottingPosition(1, 0))).toBe(true);
  });
});

describe("computeFlowDuration", () => {
  it("sorts descending and assigns Weibull plotting positions", () => {
    // 4 finite values: [1, 4, 2, 3] → sorted desc [4, 3, 2, 1].
    // Plotting positions: 1/5, 2/5, 3/5, 4/5.
    const points = computeFlowDuration([[1], [4], [2], [3]]);
    expect(points.map((p) => p.flow)).toEqual([4, 3, 2, 1]);
    expect(points.map((p) => p.exceedance)).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it("collapses multi-scenario to the per-step mean before ranking", () => {
    // Day means: [(1+3)/2, (2+4)/2] = [2, 3]. Sorted desc: [3, 2].
    const points = computeFlowDuration([
      [1, 3],
      [2, 4],
    ]);
    expect(points.map((p) => p.flow)).toEqual([3, 2]);
  });

  it("drops non-finite samples before ranking", () => {
    // [5, NaN, 1, NaN] → finite [5, 1] → desc [5, 1].
    const points = computeFlowDuration([[5], [NaN], [1], [NaN]]);
    expect(points.map((p) => p.flow)).toEqual([5, 1]);
    // N=2 → exceedance positions 1/3, 2/3.
    expect(points[0].exceedance).toBeCloseTo(1 / 3, 6);
    expect(points[1].exceedance).toBeCloseTo(2 / 3, 6);
  });

  it("returns [] when every sample is non-finite", () => {
    expect(computeFlowDuration([[NaN], [NaN]])).toEqual([]);
  });

  it("returns [] for an empty input", () => {
    expect(computeFlowDuration([])).toEqual([]);
  });

  it("respects a non-default formula", () => {
    const points = computeFlowDuration([[10], [5], [1]], { formula: "cunnane" });
    // N=3, rank 1 → (1 - 0.4) / 3.2 ≈ 0.1875
    expect(points[0].exceedance).toBeCloseTo(0.6 / 3.2, 6);
  });
});

describe("flowAtExceedance", () => {
  // Points with ascending exceedance (descending flow) — matches what
  // computeFlowDuration emits.
  const points: FlowDurationPoint[] = [
    { exceedance: 0.1, flow: 100 },
    { exceedance: 0.5, flow: 50 },
    { exceedance: 0.9, flow: 10 },
  ];

  it("clamps below the minimum exceedance to the largest flow", () => {
    expect(flowAtExceedance(points, 0)).toBe(100);
  });
  it("clamps above the maximum exceedance to the smallest flow", () => {
    expect(flowAtExceedance(points, 1)).toBe(10);
  });
  it("returns the exact flow at a known exceedance point", () => {
    expect(flowAtExceedance(points, 0.5)).toBe(50);
  });
  it("linearly interpolates between adjacent points", () => {
    // Halfway between 0.1 and 0.5 → flow halfway between 100 and 50 = 75.
    expect(flowAtExceedance(points, 0.3)).toBeCloseTo(75, 6);
  });
  it("returns NaN for empty points or non-finite frac", () => {
    expect(Number.isNaN(flowAtExceedance([], 0.5))).toBe(true);
    expect(Number.isNaN(flowAtExceedance(points, NaN))).toBe(true);
  });
});

describe("STANDARD_EXCEEDANCE_QUANTILES", () => {
  it("includes Q10, Q50, Q90 — the canonical reporting quantiles", () => {
    expect(STANDARD_EXCEEDANCE_QUANTILES).toContain(0.1);
    expect(STANDARD_EXCEEDANCE_QUANTILES).toContain(0.5);
    expect(STANDARD_EXCEEDANCE_QUANTILES).toContain(0.9);
  });
});

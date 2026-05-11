// Unit tests for the pure helpers in NodeTimeSeriesChart.
// The SVG layer is presentation; these helpers are where the correctness
// lives, so they're the only thing worth pinning down.

import { describe, it, expect } from "vitest";
import { _internal } from "../components/NodeTimeSeriesChart";

const { parseCsvSeries, paddedDomain, yTicks, buildPath, formatTick } = _internal;

describe("parseCsvSeries", () => {
  it("parses a standard date,scenario_0 CSV", () => {
    const r = parseCsvSeries(
      "flow_rec",
      "NumpyArrayNodeRecorder",
      ["date", "scenario_0"],
      [
        ["2024-01-01", "5.2"],
        ["2024-01-02", "4.8"],
        ["2024-01-03", "5.0"],
      ],
    );
    expect(r.error).toBeNull();
    expect(r.series).not.toBeNull();
    expect(r.series!.dates).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
    expect(r.series!.scenarioCount).toBe(1);
    expect(r.series!.values).toEqual([[5.2], [4.8], [5.0]]);
    expect(r.series!.yMin).toBe(4.8);
    expect(r.series!.yMax).toBe(5.2);
  });

  it("handles multiple scenarios", () => {
    const r = parseCsvSeries(
      "flow_rec",
      "NumpyArrayNodeRecorder",
      ["date", "scenario_0", "scenario_1", "scenario_2"],
      [
        ["2024-01-01", "1", "2", "3"],
        ["2024-01-02", "1.5", "2.5", "3.5"],
      ],
    );
    expect(r.error).toBeNull();
    expect(r.series!.scenarioCount).toBe(3);
    expect(r.series!.values).toEqual([[1, 2, 3], [1.5, 2.5, 3.5]]);
    expect(r.series!.yMin).toBe(1);
    expect(r.series!.yMax).toBe(3.5);
  });

  it("emits NaN for blank cells and excludes them from min/max", () => {
    const r = parseCsvSeries(
      "flow_rec",
      "NumpyArrayNodeRecorder",
      ["date", "scenario_0"],
      [
        ["2024-01-01", "5"],
        ["2024-01-02", ""],
        ["2024-01-03", "3"],
      ],
    );
    expect(r.error).toBeNull();
    expect(Number.isNaN(r.series!.values[1][0])).toBe(true);
    expect(r.series!.yMin).toBe(3);
    expect(r.series!.yMax).toBe(5);
  });

  it("returns an error when there are no scenario columns", () => {
    const r = parseCsvSeries(
      "rec",
      "X",
      ["date"],
      [["2024-01-01"]],
    );
    expect(r.series).toBeNull();
    expect(r.error).toMatch(/no scenario/i);
  });

  it("returns an error when every value is non-finite", () => {
    const r = parseCsvSeries(
      "rec",
      "X",
      ["date", "scenario_0"],
      [
        ["2024-01-01", ""],
        ["2024-01-02", "n/a"],
      ],
    );
    expect(r.series).toBeNull();
    expect(r.error).toMatch(/no finite/i);
  });

  it("accepts numeric cells (Rust preview may return numbers, not strings)", () => {
    const r = parseCsvSeries(
      "rec",
      "X",
      ["date", "scenario_0"],
      [
        ["2024-01-01", 5 as unknown as string],
        ["2024-01-02", 3 as unknown as string],
      ],
    );
    expect(r.error).toBeNull();
    expect(r.series!.values).toEqual([[5], [3]]);
  });
});

describe("paddedDomain", () => {
  it("pads a normal range by ~8% on each side", () => {
    const d = paddedDomain(0, 10, []);
    expect(d.lo).toBeLessThan(0);
    expect(d.hi).toBeGreaterThan(10);
    // 8% of 10 = 0.8
    expect(d.lo).toBeCloseTo(-0.8, 5);
    expect(d.hi).toBeCloseTo(10.8, 5);
  });

  it("includes reference-line values in the domain", () => {
    const d = paddedDomain(0, 5, [
      { label: "max", value: 20, color: "#000" },
      { label: "min", value: -10, color: "#000" },
    ]);
    expect(d.lo).toBeLessThanOrEqual(-10);
    expect(d.hi).toBeGreaterThanOrEqual(20);
  });

  it("synthesises a band for a flat series", () => {
    const d = paddedDomain(5, 5, []);
    expect(d.lo).toBeLessThan(5);
    expect(d.hi).toBeGreaterThan(5);
  });

  it("ignores non-finite reference values", () => {
    const d = paddedDomain(0, 1, [
      { label: "bad", value: NaN, color: "#000" },
      { label: "bad2", value: Infinity, color: "#000" },
    ]);
    // Should pad based on [0,1] only.
    expect(d.lo).toBeCloseTo(-0.08, 5);
    expect(d.hi).toBeCloseTo(1.08, 5);
  });
});

describe("yTicks", () => {
  it("produces N evenly-spaced ticks spanning [lo, hi]", () => {
    const ticks = yTicks(0, 10, 5);
    expect(ticks).toEqual([0, 2.5, 5, 7.5, 10]);
  });

  it("defaults to 5 ticks", () => {
    expect(yTicks(0, 4).length).toBe(5);
  });
});

describe("buildPath", () => {
  it("emits a single M..L..L sequence for a continuous series", () => {
    const series = {
      recorderName: "r",
      recorderType: "t",
      dates: ["a", "b", "c"],
      values: [[1], [2], [3]],
      scenarioCount: 1,
      yMin: 1,
      yMax: 3,
    };
    const xs = (i: number) => i * 10;
    const ys = (v: number) => 100 - v * 10;
    const d = buildPath(series, 0, xs, ys);
    expect(d).toMatch(/^M /);
    // 1 M + 2 L = 3 commands total
    expect((d.match(/[ML]/g) ?? []).length).toBe(3);
  });

  it("starts a new sub-path after a NaN gap", () => {
    const series = {
      recorderName: "r",
      recorderType: "t",
      dates: ["a", "b", "c", "d"],
      values: [[1], [NaN], [3], [4]],
      scenarioCount: 1,
      yMin: 1,
      yMax: 4,
    };
    const xs = (i: number) => i * 10;
    const ys = (v: number) => 100 - v * 10;
    const d = buildPath(series, 0, xs, ys);
    // First M for the initial point, then NaN breaks the pen, so the next
    // finite point must also be M.
    const moves = (d.match(/M/g) ?? []).length;
    expect(moves).toBe(2);
  });
});

describe("formatTick", () => {
  it("uses fixed notation for medium-magnitude numbers", () => {
    expect(formatTick(5.234)).toBe("5.23");
    expect(formatTick(123)).toBe("123");
    // 0.001 is at the threshold (not below it) so still rendered fixed.
    expect(formatTick(0.001)).toBe("0.001");
  });

  it("uses exponential for very small or very large", () => {
    expect(formatTick(1e7)).toMatch(/e/);
    expect(formatTick(1e-5)).toMatch(/e/);
  });

  it("renders zero plainly", () => {
    expect(formatTick(0)).toBe("0");
  });
});

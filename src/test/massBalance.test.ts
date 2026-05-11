// src/test/massBalance.test.ts
// Pins down the pure mass-balance helpers used by the T1.4 audit. Every
// metric the component renders is computed by computeMassBalance() — the UI
// is presentation only, so correctness lives here.

import { describe, it, expect } from "vitest";
import {
  BALANCE_EPS,
  BALANCE_RELATIVE_TOL,
  buildDateAxis,
  classifyNodeForBalance,
  collapseScenarios,
  computeMassBalance,
  formatSigned,
  formatVolume,
  type BalanceSeries,
} from "../lib/massBalance";

function dailyDates(start: string, count: number): string[] {
  const out: string[] = [];
  const t0 = Date.parse(start);
  for (let i = 0; i < count; i++) {
    const d = new Date(t0 + i * 86_400_000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

// Build a one-scenario BalanceSeries with constant value across `count` days.
function constSeries(
  recorderName: string,
  nodeName: string,
  role: BalanceSeries["role"],
  value: number,
  count: number,
  startDate = "2024-01-01",
): BalanceSeries {
  return {
    recorderName,
    nodeName,
    role,
    dates: dailyDates(startDate, count),
    collapsed: Array(count).fill(value),
  };
}

describe("classifyNodeForBalance", () => {
  it("maps source-type nodes to 'source'", () => {
    expect(classifyNodeForBalance("Input")).toBe("source");
    expect(classifyNodeForBalance("Catchment")).toBe("source");
    expect(classifyNodeForBalance("Discharge")).toBe("source");
  });
  it("maps Output to 'sink'", () => {
    expect(classifyNodeForBalance("Output")).toBe("sink");
  });
  it("maps Storage/Reservoir to 'storage'", () => {
    expect(classifyNodeForBalance("Storage")).toBe("storage");
    expect(classifyNodeForBalance("Reservoir")).toBe("storage");
  });
  it("treats transfer nodes as 'internal' (not double-counted in the audit)", () => {
    expect(classifyNodeForBalance("Link")).toBe("internal");
    expect(classifyNodeForBalance("River")).toBe("internal");
    expect(classifyNodeForBalance("RiverGauge")).toBe("internal");
    expect(classifyNodeForBalance("RiverSplit")).toBe("internal");
    expect(classifyNodeForBalance("AggregatedNode")).toBe("internal");
    expect(classifyNodeForBalance("VirtualStorage")).toBe("internal");
    expect(classifyNodeForBalance("AnnualVirtualStorage")).toBe("internal");
  });
  it("normalizes casing so case-variant types still classify correctly", () => {
    expect(classifyNodeForBalance("input")).toBe("source");
    expect(classifyNodeForBalance("OUTPUT")).toBe("sink");
    expect(classifyNodeForBalance("reservoir")).toBe("storage");
  });
  it("returns 'internal' for an unknown type (safe default)", () => {
    expect(classifyNodeForBalance("NotARealNodeType")).toBe("internal");
  });
});

describe("collapseScenarios", () => {
  it("averages finite cells per row", () => {
    expect(collapseScenarios([[1, 3, 5]])).toEqual([3]);
    expect(collapseScenarios([[2, 4], [6, 8]])).toEqual([3, 7]);
  });
  it("skips NaN cells in the mean", () => {
    expect(collapseScenarios([[2, NaN, 4]])).toEqual([3]);
  });
  it("emits NaN when every cell is non-finite", () => {
    const r = collapseScenarios([[NaN, NaN]]);
    expect(r.length).toBe(1);
    expect(Number.isNaN(r[0])).toBe(true);
  });
  it("returns [] for an empty input", () => {
    expect(collapseScenarios([])).toEqual([]);
  });
});

describe("buildDateAxis", () => {
  it("returns the union of dates across series, sorted ascending", () => {
    const a: BalanceSeries = {
      recorderName: "a", nodeName: "A", role: "source",
      dates: ["2024-01-02", "2024-01-03"], collapsed: [1, 1],
    };
    const b: BalanceSeries = {
      recorderName: "b", nodeName: "B", role: "sink",
      dates: ["2024-01-01", "2024-01-02"], collapsed: [1, 1],
    };
    expect(buildDateAxis([a, b])).toEqual(["2024-01-01", "2024-01-02", "2024-01-03"]);
  });
  it("returns [] for empty input", () => {
    expect(buildDateAxis([])).toEqual([]);
  });
});

describe("computeMassBalance — perfect balance", () => {
  it("zero residual when sources match sinks daily, no storage", () => {
    const inp = constSeries("flow_in", "In", "source", 10, 30);
    const out = constSeries("flow_out", "Out", "sink", 10, 30);
    const mb = computeMassBalance([inp, out]);
    expect(mb.totalInputs).toBe(300);
    expect(mb.totalOutputs).toBe(300);
    expect(mb.storageDelta).toBe(0);
    expect(mb.residual).toBe(0);
    expect(mb.pctImbalance).toBe(0);
    expect(mb.violationDays).toBe(0);
    expect(mb.daily.length).toBe(30);
    expect(mb.worstDays).toEqual([]);
  });

  it("two sources + two sinks: sums combine correctly", () => {
    const i1 = constSeries("i1", "In1", "source", 3, 10);
    const i2 = constSeries("i2", "In2", "source", 7, 10);
    const o1 = constSeries("o1", "Out1", "sink", 4, 10);
    const o2 = constSeries("o2", "Out2", "sink", 6, 10);
    const mb = computeMassBalance([i1, i2, o1, o2]);
    expect(mb.totalInputs).toBe(100);
    expect(mb.totalOutputs).toBe(100);
    expect(mb.residual).toBe(0);
    expect(mb.daily[0].inputs).toBe(10);
    expect(mb.daily[0].outputs).toBe(10);
    expect(mb.daily[0].net).toBe(0);
  });
});

describe("computeMassBalance — storage-corrected", () => {
  it("treats reservoir drawdown as legitimate excess output", () => {
    // 30 days: input 5/day = 150 total, output 8/day = 240 total.
    // Storage fell from 200 to 110 → ΔS = -90. Residual = 150 - 240 - (-90) = 0.
    const inp = constSeries("inflow", "Src", "source", 5, 30);
    const out = constSeries("demand", "Sink", "sink", 8, 30);
    const storageLevels: number[] = [];
    for (let i = 0; i < 30; i++) storageLevels.push(200 - i * 3);
    const sto: BalanceSeries = {
      recorderName: "vol",
      nodeName: "Lake",
      role: "storage",
      dates: dailyDates("2024-01-01", 30),
      collapsed: storageLevels,
    };
    const mb = computeMassBalance([inp, out, sto]);
    expect(mb.totalInputs).toBe(150);
    expect(mb.totalOutputs).toBe(240);
    expect(mb.storageDelta).toBeCloseTo(-87, 6); // 113 - 200
    expect(mb.residual).toBeCloseTo(-3, 6); // small mismatch from integer stepping
    // pctImbalance ≈ |residual| / max(in,out) = 3/240 ≈ 1.25%
    expect(mb.pctImbalance).toBeCloseTo(1.25, 1);
  });

  it("sums storage delta across multiple reservoirs", () => {
    const inp = constSeries("inflow", "Src", "source", 0, 10);
    const out = constSeries("demand", "Sink", "sink", 0, 10);
    const a: BalanceSeries = {
      recorderName: "a", nodeName: "A", role: "storage",
      dates: dailyDates("2024-01-01", 10),
      collapsed: [100, 100, 100, 100, 100, 100, 100, 100, 100, 110], // +10
    };
    const b: BalanceSeries = {
      recorderName: "b", nodeName: "B", role: "storage",
      dates: dailyDates("2024-01-01", 10),
      collapsed: [50, 50, 50, 50, 50, 50, 50, 50, 50, 45], // -5
    };
    const mb = computeMassBalance([inp, out, a, b]);
    expect(mb.storageDelta).toBe(5);
  });

  it("ignores leading NaN when computing storage delta", () => {
    const sto: BalanceSeries = {
      recorderName: "s", nodeName: "S", role: "storage",
      dates: dailyDates("2024-01-01", 5),
      collapsed: [NaN, 100, 95, 90, 80], // first finite = 100, last = 80, ΔS = -20
    };
    const mb = computeMassBalance([sto]);
    expect(mb.storageDelta).toBe(-20);
  });
});

describe("computeMassBalance — violations", () => {
  it("flags per-day negative imbalance as a violation when no storage explains it", () => {
    // 5 days: inputs[10,10,10,10,10], outputs[10,10,20,10,10] → day 3 has net -10.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: dailyDates("2024-01-01", 5),
      collapsed: [10, 10, 10, 10, 10],
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: dailyDates("2024-01-01", 5),
      collapsed: [10, 10, 20, 10, 10],
    };
    const mb = computeMassBalance([inp, out]);
    expect(mb.violationDays).toBe(1);
    expect(mb.daily[2].net).toBe(-10);
    expect(mb.worstDays.length).toBe(1);
    expect(mb.worstDays[0].date).toBe(mb.daily[2].date);
    expect(mb.worstDays[0].net).toBe(-10);
  });

  it("does NOT flag tiny floating-point noise as a violation", () => {
    // Net per-day ≈ -1e-12, well below the absolute floor.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: dailyDates("2024-01-01", 3),
      collapsed: [1, 1, 1],
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: dailyDates("2024-01-01", 3),
      collapsed: [1 + 1e-12, 1 + 1e-12, 1 + 1e-12],
    };
    const mb = computeMassBalance([inp, out]);
    expect(mb.violationDays).toBe(0);
  });

  it("does NOT flag a sub-relative-tolerance dip on a large flow magnitude", () => {
    // Day 0: in=10000, out=10000.5 → |net|/max=5e-5 < default 1e-4 → no flag.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: ["2024-01-01"], collapsed: [10000],
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: ["2024-01-01"], collapsed: [10000.5],
    };
    const mb = computeMassBalance([inp, out]);
    expect(mb.violationDays).toBe(0);
  });

  it("returns at most worstDayLimit entries in worstDays", () => {
    // Ten violation days; only top 3 surfaced when limit=3.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: dailyDates("2024-01-01", 10),
      collapsed: Array(10).fill(0),
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: dailyDates("2024-01-01", 10),
      collapsed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    };
    const mb = computeMassBalance([inp, out], { worstDayLimit: 3 });
    expect(mb.worstDays.length).toBe(3);
    expect(mb.worstDays[0].net).toBe(-10); // most-negative first
    expect(mb.worstDays[1].net).toBe(-9);
    expect(mb.worstDays[2].net).toBe(-8);
  });

  it("respects a custom relative tolerance", () => {
    // 1% imbalance is normally flagged. With relTol=0.05 it should be ignored.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: ["2024-01-01"], collapsed: [100],
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: ["2024-01-01"], collapsed: [101], // 1% over
    };
    expect(computeMassBalance([inp, out]).violationDays).toBe(1);
    expect(computeMassBalance([inp, out], { relTol: 0.05 }).violationDays).toBe(0);
  });
});

describe("computeMassBalance — edge cases", () => {
  it("returns empty totals for [] input", () => {
    const mb = computeMassBalance([]);
    expect(mb.totalInputs).toBe(0);
    expect(mb.totalOutputs).toBe(0);
    expect(mb.daily).toEqual([]);
    expect(Number.isNaN(mb.pctImbalance)).toBe(true);
  });

  it("returns NaN pctImbalance when both totals are zero (unstarted run)", () => {
    const inp = constSeries("i", "I", "source", 0, 5);
    const out = constSeries("o", "O", "sink", 0, 5);
    const mb = computeMassBalance([inp, out]);
    expect(mb.totalInputs).toBe(0);
    expect(mb.totalOutputs).toBe(0);
    expect(Number.isNaN(mb.pctImbalance)).toBe(true);
    expect(mb.violationDays).toBe(0);
  });

  it("ignores 'internal' role series entirely", () => {
    // A Link recorder must not contribute to either total, even if present
    // in the series list (e.g. user attached a NumpyArrayNodeRecorder to a Link).
    const inp = constSeries("i", "I", "source", 5, 5);
    const out = constSeries("o", "O", "sink", 5, 5);
    const link = constSeries("L", "L", "internal", 99, 5);
    const mb = computeMassBalance([inp, out, link]);
    expect(mb.totalInputs).toBe(25);
    expect(mb.totalOutputs).toBe(25);
    expect(mb.residual).toBe(0);
  });

  it("handles misaligned date axes via union and treats missing cells as 0", () => {
    // Source covers days 1-3, sink covers days 2-4 — union is 1-4.
    const inp: BalanceSeries = {
      recorderName: "i", nodeName: "I", role: "source",
      dates: dailyDates("2024-01-01", 3),
      collapsed: [10, 10, 10],
    };
    const out: BalanceSeries = {
      recorderName: "o", nodeName: "O", role: "sink",
      dates: dailyDates("2024-01-02", 3),
      collapsed: [10, 10, 10],
    };
    const mb = computeMassBalance([inp, out]);
    expect(mb.daily.length).toBe(4);
    expect(mb.totalInputs).toBe(30);
    expect(mb.totalOutputs).toBe(30);
    // Day 1: source=10, sink missing → out=0 → net=10
    expect(mb.daily[0].inputs).toBe(10);
    expect(mb.daily[0].outputs).toBe(0);
    // Day 4: source missing → in=0, sink=10 → net=-10 (a candidate violation)
    expect(mb.daily[3].inputs).toBe(0);
    expect(mb.daily[3].outputs).toBe(10);
    expect(mb.violationDays).toBeGreaterThanOrEqual(1);
  });

  it("pins the public tolerance constants", () => {
    // If these change a downstream user might re-paint a previously-clean
    // run as violation. Force review by surfacing the values in the test.
    expect(BALANCE_EPS).toBe(1e-6);
    expect(BALANCE_RELATIVE_TOL).toBe(1e-4);
  });
});

describe("formatVolume", () => {
  it("uses fixed notation for medium magnitudes", () => {
    expect(formatVolume(5.234)).toBe("5.23");
    expect(formatVolume(123)).toBe("123");
  });
  it("uses k / M suffixes for large numbers", () => {
    expect(formatVolume(1234)).toBe("1.23k");
    expect(formatVolume(1_500_000)).toBe("1.50M");
  });
  it("uses exponential notation outside [1e-3, 1e9)", () => {
    expect(formatVolume(1e10)).toMatch(/e/);
    expect(formatVolume(1e-5)).toMatch(/e/);
  });
  it("renders zero and non-finite cleanly", () => {
    expect(formatVolume(0)).toBe("0");
    expect(formatVolume(NaN)).toBe("—");
    expect(formatVolume(Infinity)).toBe("—");
  });
});

describe("formatSigned", () => {
  it("uses a plus sign for positives, minus for negatives", () => {
    expect(formatSigned(5)).toMatch(/^\+/);
    expect(formatSigned(-5)).toMatch(/^−/); // U+2212 minus, not hyphen
  });
  it("renders zero without a sign", () => {
    expect(formatSigned(0)).toBe("0");
  });
});

// src/test/sankeyLayout.test.ts
// Pins the layout math used by the T2.5 Sankey view. The renderer is a
// thin SVG layer over these results, so anything that breaks here breaks
// the visible diagram.

import { describe, it, expect } from "vitest";
import {
  computeSankeyLayout,
  formatSankeyFlow,
  type SankeyData,
} from "../lib/sankeyLayout";

function makeData(
  edges: Array<{ u: string; v: string; total: number; annual?: number | null }>,
): SankeyData {
  return {
    edges: edges.map((e) => ({ ...e, annual: e.annual ?? null })),
    totalRoutes: edges.length,
    timesteps: 365,
  };
}

describe("computeSankeyLayout — degenerate inputs", () => {
  it("returns an empty layout for zero edges", () => {
    const l = computeSankeyLayout(makeData([]));
    expect(l.nodes).toEqual([]);
    expect(l.edges).toEqual([]);
    expect(l.cycleDetected).toBe(false);
  });

  it("drops edges with zero / negative / non-finite totals", () => {
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "B", total: 10 },
        { u: "B", v: "C", total: 0 },
        { u: "C", v: "D", total: -5 },
        { u: "D", v: "E", total: NaN },
      ]),
    );
    // Only A→B survives.
    expect(l.edges.length).toBe(1);
    expect(l.edges[0].u).toBe("A");
    expect(l.edges[0].v).toBe("B");
  });
});

describe("computeSankeyLayout — layering", () => {
  it("places source nodes at layer 0 and stretches longest-path layers downstream", () => {
    // A → B → C → D, plus A → D (short-cut). The longest-path for D is via
    // A→B→C→D so D ends up at layer 3, not at layer 1.
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "B", total: 5 },
        { u: "B", v: "C", total: 5 },
        { u: "C", v: "D", total: 5 },
        { u: "A", v: "D", total: 1 },
      ]),
    );
    const byName = new Map(l.nodes.map((n) => [n.name, n]));
    expect(byName.get("A")!.layer).toBe(0);
    expect(byName.get("B")!.layer).toBe(1);
    expect(byName.get("C")!.layer).toBe(2);
    expect(byName.get("D")!.layer).toBe(3);
  });

  it("flags cycleDetected when the edge graph contains a cycle", () => {
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "B", total: 5 },
        { u: "B", v: "A", total: 5 },
        { u: "B", v: "C", total: 5 },
      ]),
    );
    expect(l.cycleDetected).toBe(true);
    // The cyclic nodes still get a layer assignment (defaulting to 0) so
    // the layout renders.
    expect(l.nodes.length).toBe(3);
  });
});

describe("computeSankeyLayout — throughput + heights", () => {
  it("assigns inFlow / outFlow / throughput from the supplied edge totals", () => {
    const l = computeSankeyLayout(
      makeData([
        { u: "Src", v: "Mid", total: 7 },
        { u: "Mid", v: "Sink", total: 7 },
      ]),
    );
    const mid = l.nodes.find((n) => n.name === "Mid")!;
    expect(mid.inFlow).toBe(7);
    expect(mid.outFlow).toBe(7);
    expect(mid.throughput).toBe(7);
    const src = l.nodes.find((n) => n.name === "Src")!;
    expect(src.inFlow).toBe(0);
    expect(src.outFlow).toBe(7);
    expect(src.throughput).toBe(7);
  });

  it("auto-scales heightPerUnit so the tallest layer fits maxHeight", () => {
    // Two parallel paths of equal flow → middle layer carries 2 × flow.
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "X", total: 10 },
        { u: "B", v: "X", total: 10 },
        { u: "X", v: "Y", total: 20 },
      ]),
      { maxHeight: 200, nodeGap: 4, minNodeHeight: 4 },
    );
    expect(l.height).toBeLessThanOrEqual(200);
    expect(l.height).toBeGreaterThan(0);
  });

  it("honours a user-supplied heightPerUnit for deterministic geometry", () => {
    const l = computeSankeyLayout(
      makeData([{ u: "A", v: "B", total: 10 }]),
      { heightPerUnit: 2, minNodeHeight: 0 },
    );
    const a = l.nodes.find((n) => n.name === "A")!;
    expect(a.height).toBe(20);
  });
});

describe("computeSankeyLayout — edges", () => {
  it("emits one laid-out edge per usable input edge", () => {
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "B", total: 5 },
        { u: "A", v: "C", total: 3 },
      ]),
    );
    expect(l.edges.length).toBe(2);
    expect(new Set(l.edges.map((e) => `${e.u}->${e.v}`))).toEqual(
      new Set(["A->B", "A->C"]),
    );
  });

  it("ribbon width is proportional to flow within a node's stripe budget", () => {
    // A has 10 + 5 outflow. The 10-edge should be wider than the 5-edge.
    const l = computeSankeyLayout(
      makeData([
        { u: "A", v: "B", total: 10 },
        { u: "A", v: "C", total: 5 },
      ]),
      { heightPerUnit: 1, minRibbonWidth: 0 },
    );
    const big = l.edges.find((e) => e.v === "B")!;
    const small = l.edges.find((e) => e.v === "C")!;
    expect(big.width).toBeGreaterThan(small.width);
    // 10/5 ratio survives within float precision.
    expect(big.width / small.width).toBeCloseTo(2, 6);
  });

  it("each laid-out edge has a valid SVG cubic-bézier path", () => {
    const l = computeSankeyLayout(
      makeData([{ u: "A", v: "B", total: 5 }]),
    );
    expect(l.edges[0].path).toMatch(/^M [\d.-]+ [\d.-]+ C/);
  });
});

describe("computeSankeyLayout — droppedNodes", () => {
  it("does not list any node when every node has non-zero throughput", () => {
    const l = computeSankeyLayout(
      makeData([{ u: "A", v: "B", total: 5 }]),
    );
    expect(l.droppedNodes).toEqual([]);
  });
});

describe("formatSankeyFlow", () => {
  it("uses suffixes for large magnitudes", () => {
    expect(formatSankeyFlow(1500)).toBe("1.50k");
    expect(formatSankeyFlow(2_500_000)).toBe("2.50M");
    expect(formatSankeyFlow(7_000_000_000)).toBe("7.00G");
  });
  it("falls back to fixed precision in the middle range", () => {
    expect(formatSankeyFlow(123)).toBe("123");
    expect(formatSankeyFlow(1.23)).toBe("1.23");
    expect(formatSankeyFlow(0.123)).toBe("0.123");
  });
  it("renders zero and NaN sensibly", () => {
    expect(formatSankeyFlow(0)).toBe("0");
    expect(formatSankeyFlow(NaN)).toBe("—");
  });
});

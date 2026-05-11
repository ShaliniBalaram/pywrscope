// src/test/sourceAttribution.test.ts
// Pins the source-attribution math used by the T3.10 view. The component
// layer is a bar + table; correctness lives here.

import { describe, it, expect } from "vitest";
import {
  ATTRIBUTION_EPS,
  computeSourceAttribution,
  formatFraction,
} from "../lib/sourceAttribution";
import type { PywrModel } from "../types/pywr";

// Tiny model builder that takes node names/types plus edge pairs. Wrapping
// the cast in one place keeps the tests below readable.
function makeModel(opts: {
  nodes: Array<{ name: string; type: string }>;
  edges: Array<[string, string]>;
}): PywrModel {
  return {
    nodes: opts.nodes.map((n) => {
      const node: Record<string, unknown> = { name: n.name, type: n.type };
      return node as unknown as PywrModel["nodes"][number];
    }),
    edges: opts.edges,
    parameters: {},
    recorders: {},
    timestepper: { start: "2024-01-01", end: "2024-12-31", timestep: 1 },
  };
}

function flowMap(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

describe("computeSourceAttribution — trivial cases", () => {
  it("returns 100% self-attribution when the sink is itself a source", () => {
    const model = makeModel({
      nodes: [{ name: "Spring", type: "Catchment" }],
      edges: [],
    });
    const r = computeSourceAttribution(model, flowMap({ Spring: 50 }), "Spring");
    expect(r.error).toBeNull();
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].name).toBe("Spring");
    expect(r.sources[0].fraction).toBe(1);
    expect(r.sources[0].contribution).toBe(50);
    expect(r.unresolved).toBe(0);
  });

  it("errors when the sink has no recorded flow", () => {
    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      edges: [["Src", "Sink"]],
    });
    const r = computeSourceAttribution(model, flowMap({ Src: 10 }), "Sink");
    expect(r.error).toMatch(/no recorded flow/);
    expect(r.sources).toEqual([]);
  });

  it("errors when the sink isn't in the model", () => {
    const model = makeModel({ nodes: [], edges: [] });
    const r = computeSourceAttribution(model, new Map(), "Ghost");
    expect(r.error).toMatch(/not found/);
  });
});

describe("computeSourceAttribution — linear chain", () => {
  it("attributes 100% to a single upstream source through a chain", () => {
    // Src → Link → Sink. Recorded flow 10 everywhere.
    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Link", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["Src", "Link"],
        ["Link", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ Src: 10, Link: 10, Sink: 10 }),
      "Sink",
    );
    expect(r.error).toBeNull();
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].name).toBe("Src");
    expect(r.sources[0].fraction).toBe(1);
    expect(r.sources[0].contribution).toBe(10);
    expect(r.sinkFlow).toBe(10);
  });
});

describe("computeSourceAttribution — split inflow", () => {
  it("splits attribution proportionally between two sources feeding a sink", () => {
    // SrcA (8) ───┐
    //             ├── Sink (10)
    // SrcB (2) ───┘
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Catchment" },
        { name: "SrcB", type: "Catchment" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Sink"],
        ["SrcB", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ SrcA: 8, SrcB: 2, Sink: 10 }),
      "Sink",
    );
    expect(r.sources.length).toBe(2);
    // SrcA has 8/10 = 80% share.
    const srcA = r.sources.find((s) => s.name === "SrcA")!;
    const srcB = r.sources.find((s) => s.name === "SrcB")!;
    expect(srcA.fraction).toBeCloseTo(0.8, 9);
    expect(srcB.fraction).toBeCloseTo(0.2, 9);
    expect(srcA.contribution).toBeCloseTo(8, 9);
    expect(srcB.contribution).toBeCloseTo(2, 9);
    // Sort order: SrcA first (larger).
    expect(r.sources[0].name).toBe("SrcA");
  });

  it("ignores parents with zero recorded flow", () => {
    // Two parents but only one carried water this run.
    const model = makeModel({
      nodes: [
        { name: "Live", type: "Input" },
        { name: "Dead", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["Live", "Sink"],
        ["Dead", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ Live: 5, Dead: 0, Sink: 5 }),
      "Sink",
    );
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].name).toBe("Live");
    expect(r.sources[0].fraction).toBe(1);
    expect(r.unresolved).toBe(0);
  });
});

describe("computeSourceAttribution — multi-hop with junctions", () => {
  it("propagates attribution through a Link junction with two upstreams", () => {
    // SrcA (6) ─┐
    //           ├─ Link (10) → Sink (10)
    // SrcB (4) ─┘
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Input" },
        { name: "SrcB", type: "Input" },
        { name: "Link", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Link"],
        ["SrcB", "Link"],
        ["Link", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ SrcA: 6, SrcB: 4, Link: 10, Sink: 10 }),
      "Sink",
    );
    const srcA = r.sources.find((s) => s.name === "SrcA")!;
    const srcB = r.sources.find((s) => s.name === "SrcB")!;
    expect(srcA.fraction).toBeCloseTo(0.6, 9);
    expect(srcB.fraction).toBeCloseTo(0.4, 9);
    // Fractions sum to 1 within float precision.
    expect(srcA.fraction + srcB.fraction).toBeCloseTo(1, 9);
  });

  it("attributes correctly when one source feeds the sink via two paths", () => {
    // SrcA ─→ Link1 ─→ Sink
    //   └──→ Link2 ───┘
    // Both links carry 5; sink carries 10. All flow originates at SrcA.
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Input" },
        { name: "Link1", type: "Link" },
        { name: "Link2", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Link1"],
        ["SrcA", "Link2"],
        ["Link1", "Sink"],
        ["Link2", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ SrcA: 10, Link1: 5, Link2: 5, Sink: 10 }),
      "Sink",
    );
    expect(r.sources.length).toBe(1);
    expect(r.sources[0].name).toBe("SrcA");
    expect(r.sources[0].fraction).toBeCloseTo(1, 9);
  });
});

describe("computeSourceAttribution — unresolved share", () => {
  it("surfaces unresolved fraction when an upstream branch has no recorded flow", () => {
    // SrcA → Junction → Sink. Junction has 10 recorded but SrcA has 0
    // recorded — the chain is missing data upstream of the junction.
    // Junction itself is a Link (not a source type) so the walk can't end
    // there; with no positive-flow parents the claim becomes unresolved.
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Input" },
        { name: "Junction", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Junction"],
        ["Junction", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ SrcA: 0, Junction: 10, Sink: 10 }),
      "Sink",
    );
    expect(r.sources.length).toBe(0);
    expect(r.unresolved).toBeCloseTo(1, 9);
  });

  it("attributes resolved share to recorded sources and rolls the rest to unresolved", () => {
    // Two parents into Sink: SrcA carries 6 (recorded) and a Link with no
    // upstream recorder carries the rest.
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Input" },
        { name: "BlindLink", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Sink"],
        ["BlindLink", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ SrcA: 6, BlindLink: 4, Sink: 10 }),
      "Sink",
    );
    // SrcA share = 6/10 = 60%. BlindLink carries 4, but it's a Link with no
    // upstream source recorder, so its claim becomes unresolved.
    const srcA = r.sources.find((s) => s.name === "SrcA")!;
    expect(srcA.fraction).toBeCloseTo(0.6, 9);
    expect(r.unresolved).toBeCloseTo(0.4, 9);
  });
});

describe("computeSourceAttribution — cycle handling", () => {
  it("flags cycleDetected when a directed cycle traps claim", () => {
    // A → B → C → Sink, plus B ↔ C cycle so claim never settles for B.
    const model = makeModel({
      nodes: [
        { name: "A", type: "Input" },
        { name: "B", type: "Link" },
        { name: "C", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["A", "B"],
        ["B", "C"],
        ["C", "B"], // cycle
        ["C", "Sink"],
      ],
    });
    const r = computeSourceAttribution(
      model,
      flowMap({ A: 10, B: 10, C: 10, Sink: 10 }),
      "Sink",
    );
    // The cycle means B and C are never "ready" in Kahn's order. C is sink's
    // only parent — without processing C we can't propagate any claim
    // upstream, so the entire share is unresolved AND cycleDetected fires.
    expect(r.cycleDetected).toBe(true);
    expect(r.sources.length).toBe(0);
    expect(r.unresolved).toBeCloseTo(1, 9);
  });
});

describe("formatFraction", () => {
  it("renders mid-range to one decimal", () => {
    expect(formatFraction(0.32)).toBe("32.0%");
    expect(formatFraction(0.875)).toBe("87.5%");
  });
  it("rounds to clean 0% / 100% at the extremes", () => {
    expect(formatFraction(0.9999)).toBe("100%");
    expect(formatFraction(0)).toBe("0%");
  });
  it("uses '<0.1%' for tiny non-zero shares so they don't disappear", () => {
    expect(formatFraction(0.0001)).toBe("<0.1%");
  });
  it("renders NaN as em-dash", () => {
    expect(formatFraction(NaN)).toBe("—");
  });
});

describe("ATTRIBUTION_EPS", () => {
  it("matches the project-wide active-flow threshold", () => {
    // Same value used by useRunResults.ACTIVE_EPS and ResultsTab.ACTIVE_EPS.
    // If this ever drifts, the canvas highlight and this view will disagree
    // on which edges carry flow.
    expect(ATTRIBUTION_EPS).toBe(1e-9);
  });
});

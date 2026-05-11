// Unit tests for activeFlowEdges — the pure function that decides which edges
// should render highlighted on the canvas/map.
//
// The contract (from useRunResults.ts): an edge (u, v) is "active" iff both
// endpoints lie on some path from the selected source node to an Output sink
// that has non-zero recorded flow. We never highlight an edge that dead-ends
// into an inactive branch — that would mis-imply flow.

import { describe, it, expect } from "vitest";
import { activeFlowEdges } from "../hooks/useRunResults";
import type { PywrModel } from "../types/pywr";

function buildModel(
  nodes: Array<{ name: string; type: string }>,
  edges: Array<[string, string]>,
): PywrModel {
  return {
    nodes: nodes.map((n) => ({ name: n.name, type: n.type } as PywrModel["nodes"][number])),
    edges,
    parameters: {},
    recorders: {},
    timestepper: { start: "2024-01-01", end: "2024-01-02", timestep: 1 },
  };
}

describe("activeFlowEdges", () => {
  it("returns empty set when there are no active sinks downstream", () => {
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "mid", type: "Link" },
        { name: "sink", type: "Output" },
      ],
      [["src", "mid"], ["mid", "sink"]],
    );
    // sink is NOT in activeNodes — so no edge is active
    const out = activeFlowEdges(model, "src", new Set());
    expect(out.size).toBe(0);
  });

  it("highlights the single path src → sink when sink is active", () => {
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "mid", type: "Link" },
        { name: "sink", type: "Output" },
      ],
      [["src", "mid"], ["mid", "sink"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["sink"]));
    expect(out).toEqual(new Set(["src->mid", "mid->sink"]));
  });

  it("does NOT highlight edges that dead-end into an inactive sink", () => {
    // Two branches: src → a → activeSink (active)  and  src → b → deadSink (inactive)
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "a", type: "Link" },
        { name: "b", type: "Link" },
        { name: "activeSink", type: "Output" },
        { name: "deadSink", type: "Output" },
      ],
      [
        ["src", "a"],
        ["a", "activeSink"],
        ["src", "b"],
        ["b", "deadSink"],
      ],
    );
    const out = activeFlowEdges(model, "src", new Set(["activeSink"]));
    expect(out).toEqual(new Set(["src->a", "a->activeSink"]));
    expect(out.has("src->b")).toBe(false);
    expect(out.has("b->deadSink")).toBe(false);
  });

  it("highlights both branches when both sinks are active", () => {
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "a", type: "Link" },
        { name: "b", type: "Link" },
        { name: "s1", type: "Output" },
        { name: "s2", type: "Output" },
      ],
      [["src", "a"], ["a", "s1"], ["src", "b"], ["b", "s2"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["s1", "s2"]));
    expect(out).toEqual(new Set(["src->a", "a->s1", "src->b", "b->s2"]));
  });

  it("ignores edges entirely upstream of the selected node", () => {
    // upstream → src → sink  ;  selecting src should NOT highlight upstream→src
    const model = buildModel(
      [
        { name: "upstream", type: "Input" },
        { name: "src", type: "Link" },
        { name: "sink", type: "Output" },
      ],
      [["upstream", "src"], ["src", "sink"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["sink"]));
    expect(out).toEqual(new Set(["src->sink"]));
    expect(out.has("upstream->src")).toBe(false);
  });

  it("ignores active sinks that are not reachable from the source", () => {
    // Disjoint components: src → s1 (inactive)  and  other → s2 (active)
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "s1", type: "Output" },
        { name: "other", type: "Input" },
        { name: "s2", type: "Output" },
      ],
      [["src", "s1"], ["other", "s2"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["s2"]));
    expect(out.size).toBe(0);
  });

  it("only treats Output-type nodes as sinks (Storage with flow doesn't count)", () => {
    // A Storage node with recorded flow shouldn't trigger edge highlighting —
    // it's not a flow sink. Only Output nodes terminate flow paths.
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "tank", type: "Storage" },
      ],
      [["src", "tank"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["tank"]));
    expect(out.size).toBe(0);
  });

  it("handles a diamond — both paths to one active sink are highlighted", () => {
    //     src
    //    /   \
    //   a     b
    //    \   /
    //     sink (active)
    const model = buildModel(
      [
        { name: "src", type: "Input" },
        { name: "a", type: "Link" },
        { name: "b", type: "Link" },
        { name: "sink", type: "Output" },
      ],
      [["src", "a"], ["src", "b"], ["a", "sink"], ["b", "sink"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["sink"]));
    expect(out).toEqual(new Set(["src->a", "src->b", "a->sink", "b->sink"]));
  });

  it("handles lowercase node types (Pywr JSON accepts 'output' / 'Output' / 'OUTPUT')", () => {
    // Real models often ship with lowercase types — the farnham_wrz5 model
    // uses "input"/"output"/"link"/"losslink". Without normalization, the
    // Output sink wouldn't be recognized and zero edges would highlight.
    const model = buildModel(
      [
        { name: "src", type: "input" },
        { name: "mid", type: "link" },
        { name: "sink", type: "output" },
      ],
      [["src", "mid"], ["mid", "sink"]],
    );
    const out = activeFlowEdges(model, "src", new Set(["sink"]));
    expect(out).toEqual(new Set(["src->mid", "mid->sink"]));
  });

  it("returns empty when activeNodes is empty even with reachable Outputs", () => {
    const model = buildModel(
      [{ name: "src", type: "Input" }, { name: "sink", type: "Output" }],
      [["src", "sink"]],
    );
    const out = activeFlowEdges(model, "src", new Set());
    expect(out.size).toBe(0);
  });
});

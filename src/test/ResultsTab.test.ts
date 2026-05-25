// Unit tests for the pure helpers in ResultsTab.
// The component itself is mostly presentation — these helpers are where the
// correctness lives, so they're the only thing worth pinning down here.

import { describe, it, expect } from "vitest";
import { _internal } from "../components/ResultsTab";
import type { PywrModel } from "../types/pywr";

const { reachableFrom, readRecorders } = _internal;

describe("reachableFrom", () => {
  it("returns every node reachable along edge direction, excluding source", () => {
    // a → b → c → d
    //      ↘ e
    const edges: PywrModel["edges"] = [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["b", "e"],
    ];
    const set = reachableFrom("a", edges);
    expect(Array.from(set).sort()).toEqual(["b", "c", "d", "e"]);
    expect(set.has("a")).toBe(false);
  });

  it("returns empty set when source has no outgoing edges", () => {
    const edges: PywrModel["edges"] = [["a", "b"], ["c", "d"]];
    const set = reachableFrom("b", edges);
    expect(set.size).toBe(0);
  });

  it("does not loop on cycles", () => {
    // a → b → a
    const edges: PywrModel["edges"] = [["a", "b"], ["b", "a"]];
    const set = reachableFrom("a", edges);
    expect(Array.from(set)).toEqual(["b"]);
  });

  it("handles 4-tuple edges with slot info", () => {
    const edges: PywrModel["edges"] = [["a", "b", 0, "in"]];
    const set = reachableFrom("a", edges);
    expect(Array.from(set)).toEqual(["b"]);
  });

  it("returns empty set for a source not in the graph", () => {
    const edges: PywrModel["edges"] = [["a", "b"]];
    const set = reachableFrom("ghost", edges);
    expect(set.size).toBe(0);
  });
});

describe("readRecorders", () => {
  function makeModel(recorders: Record<string, unknown>): PywrModel {
    return {
      nodes: [],
      edges: [],
      parameters: {},
      // Tests deliberately pass arbitrary recorder shapes (incl. malformed
      // ones) to exercise the runtime guard in readRecorders. The cast lets
      // those fixtures coexist with the stricter PywrModel.recorders type.
      recorders: recorders as PywrModel["recorders"],
      timestepper: { start: "2024-01-01", end: "2024-01-02", timestep: 1 },
    };
  }

  it("extracts recorder → node bindings", () => {
    const model = makeModel({
      flow_at_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      storage_at_res: { type: "NumpyArrayStorageRecorder", node: "Reservoir" },
    });
    expect(readRecorders(model)).toEqual([
      { recorderName: "flow_at_sink", type: "NumpyArrayNodeRecorder", node: "Sink" },
      { recorderName: "storage_at_res", type: "NumpyArrayStorageRecorder", node: "Reservoir" },
    ]);
  });

  it("skips recorders that don't bind to a node (param recorders, etc.)", () => {
    const model = makeModel({
      param_rec: { type: "NumpyArrayParameterRecorder", param: "demand" },
      node_rec: { type: "NumpyArrayNodeRecorder", node: "Sink" },
    });
    const recs = readRecorders(model);
    expect(recs.map((r) => r.recorderName)).toEqual(["node_rec"]);
  });

  it("returns empty list when model is null", () => {
    expect(readRecorders(null)).toEqual([]);
  });

  it("tolerates malformed recorder entries", () => {
    const model = makeModel({
      bad: null,
      worse: "not an object",
      missing_node: { type: "NumpyArrayNodeRecorder" },
      good: { type: "NumpyArrayNodeRecorder", node: "Sink" },
    } as Record<string, unknown>);
    const recs = readRecorders(model);
    expect(recs.map((r) => r.recorderName)).toEqual(["good"]);
  });
});

import { describe, expect, it } from "vitest";
import type { PywrModel, PywrNode } from "../types/pywr";
import { addRecordersForNodes } from "../components/RecorderManager";

function model(nodes: PywrNode[], recorders: PywrModel["recorders"] = {}): PywrModel {
  return {
    metadata: {},
    timestepper: { start: "2026-01-01", end: "2026-01-02", timestep: 1 },
    nodes,
    edges: [],
    parameters: {},
    recorders,
  };
}

describe("addRecordersForNodes", () => {
  it("adds flow recorders for selected flow nodes", () => {
    const src = { name: "Source", type: "Input" } as PywrNode;
    const result = addRecordersForNodes(model([src]), [src], ["flow"]);

    expect(result.addedCount).toBe(1);
    expect(result.model.recorders.Source_flow).toEqual({
      type: "NumpyArrayNodeRecorder",
      node: "Source",
    });
  });

  it("adds deficit recorders only for output nodes", () => {
    const src = { name: "Source", type: "Input" } as PywrNode;
    const sink = { name: "Demand", type: "Output" } as PywrNode;
    const result = addRecordersForNodes(model([src, sink]), [src, sink], ["deficit"]);

    expect(result.addedCount).toBe(1);
    expect(result.model.recorders.Demand_deficit).toEqual({
      type: "NumpyArrayNodeDeficitRecorder",
      node: "Demand",
    });
  });

  it("does not duplicate existing recorder type and node pairs", () => {
    const src = { name: "Source", type: "Input" } as PywrNode;
    const result = addRecordersForNodes(
      model([src], {
        existing: { type: "NumpyArrayNodeRecorder", node: "Source" },
      }),
      [src],
      ["flow"],
    );

    expect(result.addedCount).toBe(0);
    expect(Object.keys(result.model.recorders)).toEqual(["existing"]);
  });
});

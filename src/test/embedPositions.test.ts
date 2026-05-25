// src/test/embedPositions.test.ts
// Verifies that on export, every node carries position.schematic and
// position.editor_position so the JSON file alone is portable across
// Pywr core / Pywr Viewer / pywr-editor.

import { describe, it, expect } from "vitest";
import { embedPositions } from "../utils/embedPositions";
import type { PywrModel } from "../types/pywr";

function baseModel(): PywrModel {
  return {
    nodes: [
      { name: "A", type: "Input" },
      { name: "B", type: "Output" },
    ],
    edges: [["A", "B"] as const],
    parameters: {},
    recorders: {},
    timestepper: { start: "2020-01-01", end: "2020-12-31", timestep: 1 },
  };
}

describe("embedPositions", () => {
  it("writes schematic and editor_position with the same coords", () => {
    const out = embedPositions(baseModel(), {
      A: { x: 100, y: 200 },
      B: { x: 300, y: 400 },
    });
    const a = out.nodes[0] as unknown as { position: Record<string, unknown> };
    const b = out.nodes[1] as unknown as { position: Record<string, unknown> };
    expect(a.position.schematic).toEqual([100, 200]);
    expect(a.position.editor_position).toEqual([100, 200]);
    expect(b.position.schematic).toEqual([300, 400]);
    expect(b.position.editor_position).toEqual([300, 400]);
  });

  it("leaves a node unchanged when no entry exists in positions", () => {
    const out = embedPositions(baseModel(), { A: { x: 1, y: 2 } });
    expect(out.nodes[0]).toHaveProperty("position");
    expect(out.nodes[1]).not.toHaveProperty("position");
  });

  it("preserves existing position keys (geographic) and overrides only schematic + editor_position", () => {
    const m = baseModel();
    (m.nodes[0] as unknown as Record<string, unknown>).position = {
      geographic: [-1.5, 53.2],
      schematic: [0, 0],
    };
    const out = embedPositions(m, { A: { x: 50, y: 60 } });
    const a = out.nodes[0] as unknown as { position: Record<string, unknown> };
    expect(a.position.geographic).toEqual([-1.5, 53.2]);
    expect(a.position.schematic).toEqual([50, 60]);
    expect(a.position.editor_position).toEqual([50, 60]);
  });

  it("ignores non-finite coordinates", () => {
    const out = embedPositions(baseModel(), {
      A: { x: NaN, y: 10 },
      B: { x: Infinity, y: 0 },
    });
    expect(out.nodes[0]).not.toHaveProperty("position");
    expect(out.nodes[1]).not.toHaveProperty("position");
  });

  it("does not mutate the input model", () => {
    const m = baseModel();
    const before = JSON.stringify(m);
    embedPositions(m, { A: { x: 1, y: 2 } });
    expect(JSON.stringify(m)).toBe(before);
  });

  it("preserves edges, parameters, recorders, timestepper unchanged", () => {
    const m = baseModel();
    const out = embedPositions(m, { A: { x: 1, y: 2 } });
    expect(out.edges).toEqual(m.edges);
    expect(out.parameters).toBe(m.parameters);
    expect(out.recorders).toBe(m.recorders);
    expect(out.timestepper).toBe(m.timestepper);
  });

  it("treats a non-object position field as absent and overwrites it", () => {
    const m = baseModel();
    (m.nodes[0] as unknown as Record<string, unknown>).position = "broken";
    const out = embedPositions(m, { A: { x: 7, y: 8 } });
    const a = out.nodes[0] as unknown as { position: Record<string, unknown> };
    expect(a.position).toEqual({
      schematic: [7, 8],
      editor_position: [7, 8],
    });
  });

  it("round-trips: embedded coords match the importer's preference order", () => {
    // The importer (App.tsx) prefers editor_position > schematic > geographic.
    // Both fields carry the same value, so the importer reads back what was written.
    const out = embedPositions(baseModel(), { A: { x: 42, y: 99 } });
    const a = out.nodes[0] as unknown as { position: Record<string, [number, number]> };
    expect(a.position.editor_position).toEqual(a.position.schematic);
  });
});

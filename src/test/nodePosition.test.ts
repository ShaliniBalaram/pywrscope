// src/test/nodePosition.test.ts
// Pin down the preference order, validity gate, and reference-identity
// contract of the position helpers. These guarantees are what make the four
// previous inline copies safe to delete — any future refactor that breaks
// them risks losing layouts on reopen or causing render storms on drag.

import { describe, expect, it } from "vitest";
import {
  extractNodePosition,
  embedNodePosition,
} from "../utils/nodePosition";
import type { PywrNode } from "../types/pywr";

// Helper: build a node with an arbitrary off-schema position object. The
// PywrNode union doesn't declare `position` (it's stored on disk but never
// read by typed paths), so a single unknown-cast is the cleanest fixture.
function nodeWithPosition(position: unknown): PywrNode {
  return {
    name: "N",
    type: "Input",
    position,
  } as unknown as PywrNode;
}

describe("extractNodePosition", () => {
  it("returns null when the node has no position field", () => {
    const node: PywrNode = { name: "N", type: "Input" };
    expect(extractNodePosition(node)).toBeNull();
  });

  it("returns null when position is null / non-object / an array", () => {
    expect(extractNodePosition(nodeWithPosition(null))).toBeNull();
    expect(extractNodePosition(nodeWithPosition("not-an-object"))).toBeNull();
    expect(extractNodePosition(nodeWithPosition([1, 2]))).toBeNull();
  });

  it("prefers editor_position over schematic over geographic", () => {
    const node = nodeWithPosition({
      editor_position: [10, 20],
      schematic: [100, 200],
      geographic: [1000, 2000],
    });
    expect(extractNodePosition(node)).toEqual({ x: 10, y: 20 });
  });

  it("falls back to schematic when editor_position is absent", () => {
    const node = nodeWithPosition({
      schematic: [100, 200],
      geographic: [1000, 2000],
    });
    expect(extractNodePosition(node)).toEqual({ x: 100, y: 200 });
  });

  it("falls back to geographic when editor_position and schematic are absent", () => {
    const node = nodeWithPosition({ geographic: [1000, 2000] });
    expect(extractNodePosition(node)).toEqual({ x: 1000, y: 2000 });
  });

  it("rejects entries that are too short or non-numeric", () => {
    expect(extractNodePosition(nodeWithPosition({ editor_position: [1] }))).toBeNull();
    expect(extractNodePosition(nodeWithPosition({ editor_position: ["a", 2] }))).toBeNull();
    expect(extractNodePosition(nodeWithPosition({ schematic: [null, 2] }))).toBeNull();
  });

  it("ignores unrelated keys on the position object", () => {
    const node = nodeWithPosition({
      something_else: [99, 99],
      editor_position: [5, 6],
    });
    expect(extractNodePosition(node)).toEqual({ x: 5, y: 6 });
  });
});

describe("embedNodePosition", () => {
  it("writes both editor_position AND schematic with identical coords", () => {
    const node: PywrNode = { name: "N", type: "Input" };
    const result = embedNodePosition(node, 100, 200);
    const pos = (result as unknown as Record<string, unknown>).position as Record<string, unknown>;
    expect(pos.editor_position).toEqual([100, 200]);
    expect(pos.schematic).toEqual([100, 200]);
  });

  it("preserves existing keys (geographic) and overrides only the two pixel keys", () => {
    const node = nodeWithPosition({ geographic: [1.5, 51.5] });
    const result = embedNodePosition(node, 50, 60);
    const pos = (result as unknown as Record<string, unknown>).position as Record<string, unknown>;
    expect(pos.geographic).toEqual([1.5, 51.5]);
    expect(pos.editor_position).toEqual([50, 60]);
    expect(pos.schematic).toEqual([50, 60]);
  });

  it("returns the same reference when coords match existing editor_position", () => {
    const node = nodeWithPosition({
      editor_position: [10, 20],
      schematic: [10, 20],
    });
    // Identity check — drives the willChange short-circuit in updateNodePositions
    expect(embedNodePosition(node, 10, 20)).toBe(node);
  });

  it("returns the same reference when coords are not finite", () => {
    const node: PywrNode = { name: "N", type: "Input" };
    expect(embedNodePosition(node, NaN, 0)).toBe(node);
    expect(embedNodePosition(node, 0, Infinity)).toBe(node);
  });

  it("replaces a non-object position field with a fresh object", () => {
    const node = nodeWithPosition("garbage");
    const result = embedNodePosition(node, 1, 2);
    const pos = (result as unknown as Record<string, unknown>).position as Record<string, unknown>;
    expect(pos.editor_position).toEqual([1, 2]);
    expect(pos.schematic).toEqual([1, 2]);
  });
});

// src/test/cascadeDelete.test.ts
// Tests for cascade reference removal on node delete.

import { describe, it, expect } from "vitest";
import {
  scrubNodeRefs,
  filterEdgesForNode,
  filterRecordersForNode,
} from "../utils/cascadeDelete";
import type {
  PywrNode,
  VirtualStorageNode,
  AggregatedStorageNode,
  AggregatedNode,
  InputNode,
} from "../types/pywr";

describe("scrubNodeRefs", () => {
  it("removes deleted name from VirtualStorage.nodes", () => {
    const n: VirtualStorageNode = {
      name: "VS1",
      type: "VirtualStorage",
      nodes: ["A", "B", "C"],
    };
    const out = scrubNodeRefs(n, "B");
    expect((out as VirtualStorageNode).nodes).toEqual(["A", "C"]);
  });

  it("removes deleted name from AggregatedStorage.storages", () => {
    const n: AggregatedStorageNode = {
      name: "AS1",
      type: "AggregatedStorage",
      storages: ["X", "Y"],
    };
    const out = scrubNodeRefs(n, "X");
    expect((out as AggregatedStorageNode).storages).toEqual(["Y"]);
  });

  it("returns the same object reference when nothing changes", () => {
    const n: AggregatedNode = {
      name: "Agg",
      type: "AggregatedNode",
      nodes: ["A", "B"],
    };
    const out = scrubNodeRefs(n, "Z");
    expect(out).toBe(n);
  });

  it("leaves nodes without ref arrays untouched", () => {
    const n: InputNode = { name: "In1", type: "Input" };
    const out = scrubNodeRefs(n, "anything");
    expect(out).toBe(n);
  });

  it("does not mutate the input", () => {
    const n: VirtualStorageNode = {
      name: "VS1",
      type: "VirtualStorage",
      nodes: ["A", "B"],
    };
    const before = JSON.stringify(n);
    scrubNodeRefs(n, "A");
    expect(JSON.stringify(n)).toBe(before);
  });

  it("ignores arrays whose elements aren't all strings", () => {
    // Defensive: a non-standard payload with mixed array shouldn't get clobbered.
    const n = {
      name: "Weird",
      type: "Input",
      nodes: ["A", 123],
    } as unknown as PywrNode;
    const out = scrubNodeRefs(n, "A");
    expect(out).toBe(n);
  });
});

describe("filterEdgesForNode", () => {
  it("removes edges where deleted node is the source", () => {
    const edges = [
      ["A", "B"] as const,
      ["C", "D"] as const,
    ];
    expect(filterEdgesForNode(edges, "A")).toEqual([
      ["C", "D"] as const,
    ]);
  });

  it("removes edges where deleted node is the target", () => {
    const edges = [
      ["A", "B"] as const,
      ["C", "B"] as const,
    ];
    expect(filterEdgesForNode(edges, "B")).toEqual([]);
  });

  it("keeps unrelated edges", () => {
    const edges = [
      ["A", "B"] as const,
      ["C", "D"] as const,
    ];
    expect(filterEdgesForNode(edges, "Z")).toEqual(edges);
  });

  it("removes self-loops where both ends are the deleted node", () => {
    const edges = [["A", "A"] as const];
    expect(filterEdgesForNode(edges, "A")).toEqual([]);
  });
});

describe("filterRecordersForNode", () => {
  it("drops a recorder whose `node` field equals the deleted name", () => {
    const recorders = {
      r1: { type: "NumpyArrayNodeRecorder", node: "Reservoir1" },
      r2: { type: "NumpyArrayNodeRecorder", node: "Reservoir2" },
    };
    expect(filterRecordersForNode(recorders, "Reservoir1")).toEqual({
      r2: { type: "NumpyArrayNodeRecorder", node: "Reservoir2" },
    });
  });

  it("keeps recorders that reference a parameter, not a node", () => {
    const recorders = {
      r1: { type: "NumpyArrayParameterRecorder", param: "p_cost" },
    };
    expect(filterRecordersForNode(recorders, "p_cost")).toEqual(recorders);
  });

  it("keeps recorders that don't reference the deleted name at all", () => {
    const recorders = {
      r1: { type: "NumpyArrayNodeRecorder", node: "Other" },
    };
    expect(filterRecordersForNode(recorders, "Reservoir1")).toEqual(recorders);
  });

  it("returns a new object (immutability)", () => {
    const recorders = { r1: { type: "X", node: "A" } };
    const out = filterRecordersForNode(recorders, "B");
    expect(out).not.toBe(recorders);
    expect(out).toEqual(recorders);
  });

  it("handles empty recorders map", () => {
    expect(filterRecordersForNode({}, "anything")).toEqual({});
  });

  it("ignores malformed (non-object) entries gracefully", () => {
    // The Record<string, PywrRecorder> type forbids non-object values, so
    // this fixture casts through unknown to simulate a JSON file that's been
    // hand-edited or corrupted — the isNodeBoundRecorder guard inside
    // filterRecordersForNode rejects them at runtime and keeps them in place.
    const recorders = {
      r1: "not-an-object",
      r2: { type: "X", node: "A" },
    } as unknown as Parameters<typeof filterRecordersForNode>[0];
    expect(filterRecordersForNode(recorders, "A")).toEqual({
      r1: "not-an-object",
    });
  });
});

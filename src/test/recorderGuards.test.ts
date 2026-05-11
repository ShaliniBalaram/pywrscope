// src/test/recorderGuards.test.ts
// Pin down the runtime contract of isNodeBoundRecorder / isParameterBoundRecorder.
//
// These are the guards that replaced four near-identical copies of the
// "is this field there?" recorder-narrowing pattern in ResultsTab,
// MassBalanceAudit, ReliabilityDashboard, ZeroFlowAnalyzer and cascadeDelete.
// Locking the behaviour here means any future change to the guard ripples
// through every consumer without silent semantic drift.

import { describe, expect, it } from "vitest";
import {
  isNodeBoundRecorder,
  isParameterBoundRecorder,
} from "../types/pywr";

describe("isNodeBoundRecorder", () => {
  it("accepts any recorder with a string `node` field", () => {
    expect(isNodeBoundRecorder({ type: "NumpyArrayNodeRecorder", node: "X" })).toBe(true);
    expect(isNodeBoundRecorder({ type: "NumpyArrayStorageRecorder", node: "R" })).toBe(true);
    expect(isNodeBoundRecorder({ type: "NumpyArrayNormalisedStorageRecorder", node: "R" })).toBe(true);
    expect(isNodeBoundRecorder({ type: "NumpyArrayNodeDeficitRecorder", node: "Y" })).toBe(true);
  });

  it("accepts unknown recorder classes that carry a node binding", () => {
    // Pywr exposes many recorder classes (MeanFlowNodeRecorder,
    // TotalDeficitNodeRecorder, ...) that we don't model explicitly. Any
    // object with `node: string` is treated as node-bound — that's the
    // contract cascade-delete depends on to prune dangling refs.
    expect(isNodeBoundRecorder({ type: "MeanFlowNodeRecorder", node: "Z" })).toBe(true);
    expect(isNodeBoundRecorder({ type: "CustomUserRecorder", node: "Z" })).toBe(true);
  });

  it("rejects parameter recorders (no node field)", () => {
    expect(
      isNodeBoundRecorder({ type: "NumpyArrayParameterRecorder", param: "p" }),
    ).toBe(false);
  });

  it("rejects malformed values", () => {
    expect(isNodeBoundRecorder(null)).toBe(false);
    expect(isNodeBoundRecorder(undefined)).toBe(false);
    expect(isNodeBoundRecorder("not-an-object")).toBe(false);
    expect(isNodeBoundRecorder(42)).toBe(false);
    expect(isNodeBoundRecorder([])).toBe(false);
    expect(isNodeBoundRecorder({})).toBe(false);
    expect(isNodeBoundRecorder({ type: "X" })).toBe(false); // missing node
    expect(isNodeBoundRecorder({ node: "X" })).toBe(false); // missing type
    expect(isNodeBoundRecorder({ type: "X", node: 42 })).toBe(false); // non-string node
    expect(isNodeBoundRecorder({ type: 42, node: "X" })).toBe(false); // non-string type
  });

  it("narrows the type so consumers can read .node without a cast", () => {
    const raw: unknown = { type: "NumpyArrayNodeRecorder", node: "Sink" };
    if (isNodeBoundRecorder(raw)) {
      // This line would fail to compile if the guard didn't narrow correctly.
      const _: string = raw.node;
      expect(_).toBe("Sink");
    } else {
      throw new Error("guard should have matched");
    }
  });
});

describe("isParameterBoundRecorder", () => {
  it("accepts recorders with a string `param` field", () => {
    expect(
      isParameterBoundRecorder({ type: "NumpyArrayParameterRecorder", param: "demand" }),
    ).toBe(true);
  });

  it("accepts unknown recorder classes that carry a param binding", () => {
    expect(
      isParameterBoundRecorder({ type: "CustomParameterRecorder", param: "x" }),
    ).toBe(true);
  });

  it("rejects node recorders and malformed values", () => {
    expect(
      isParameterBoundRecorder({ type: "NumpyArrayNodeRecorder", node: "X" }),
    ).toBe(false);
    expect(isParameterBoundRecorder(null)).toBe(false);
    expect(isParameterBoundRecorder({ type: "X", param: 42 })).toBe(false);
  });

  it("narrows the type so consumers can read .param without a cast", () => {
    const raw: unknown = { type: "NumpyArrayParameterRecorder", param: "demand" };
    if (isParameterBoundRecorder(raw)) {
      const _: string = raw.param;
      expect(_).toBe("demand");
    } else {
      throw new Error("guard should have matched");
    }
  });
});

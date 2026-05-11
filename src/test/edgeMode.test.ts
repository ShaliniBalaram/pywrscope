// src/test/edgeMode.test.ts
// Sniff-test for the new edge-mode flow. Pins down all three transitions
// of the state machine that App.tsx uses on each node-click in edge mode.

import { describe, it, expect } from "vitest";
import { nextEdgeStep } from "../utils/edgeMode";

describe("nextEdgeStep", () => {
  it("picks the source on the first click (no source yet)", () => {
    expect(nextEdgeStep(null, "A")).toEqual({ kind: "pickSource", source: "A" });
  });

  it("cancels when the same node is clicked again", () => {
    expect(nextEdgeStep("A", "A")).toEqual({ kind: "cancelSource" });
  });

  it("connects source to a different target on the second click", () => {
    expect(nextEdgeStep("A", "B")).toEqual({ kind: "connect", from: "A", to: "B" });
  });

  it("is pure: same input → same output, no shared state", () => {
    const a = nextEdgeStep("A", "B");
    const b = nextEdgeStep("A", "B");
    expect(a).toEqual(b);
    // Distinct objects so callers can't share mutation
    expect(a).not.toBe(b);
  });

  it("treats names as opaque strings (works for any node identifier)", () => {
    expect(nextEdgeStep(null, "")).toEqual({ kind: "pickSource", source: "" });
    expect(nextEdgeStep("a b c", "a b c")).toEqual({ kind: "cancelSource" });
    expect(nextEdgeStep("Reservoir/Top", "Outlet#1")).toEqual({
      kind: "connect",
      from: "Reservoir/Top",
      to: "Outlet#1",
    });
  });

  it("regression: target click never returns pickSource (the old sticky-mode bug)", () => {
    // Before the fix, App.tsx never reached the connect+exit branch from
    // Canvas.onNodeClick, so edge mode stayed on after one edge. The state
    // machine must always classify "source set + click different node" as
    // a connect step — never as a fresh pickSource.
    const step = nextEdgeStep("A", "B");
    expect(step.kind).toBe("connect");
  });
});

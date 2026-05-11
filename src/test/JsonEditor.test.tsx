// src/test/JsonEditor.test.tsx
// Pins the "see what gets saved" invariant: when the live model changes
// (e.g. after a cascade-delete), the JSON tab text re-renders to match —
// the deleted node, its touching edges, and any dependent recorders all
// disappear from the visible JSON without the user doing anything.
//
// Without this test, a future refactor that broke the JsonEditor's sync
// effect could silently regress to "JSON tab shows stale model".

import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { JsonEditor } from "../components/JsonEditor";
import type { PywrModel } from "../types/pywr";

afterEach(() => cleanup());

function modelWith3Nodes(): PywrModel {
  return {
    metadata: { title: "T", description: "", minimum_version: "1.0" },
    timestepper: { start: "2020-01-01", end: "2020-12-31", timestep: 1 },
    nodes: [
      { name: "Reservoir1", type: "Storage", max_volume: 100 },
      { name: "Link1", type: "Link" },
      { name: "Demand1", type: "Output" },
    ],
    edges: [
      ["Reservoir1", "Link1"],
      ["Link1", "Demand1"],
    ],
    parameters: {},
    recorders: {
      r1: { type: "NumpyArrayNodeRecorder", node: "Reservoir1" },
    },
  };
}

// Mirror the cascade `pywrJson.removeNode` performs — node out of nodes[],
// touching edges out of edges[], dependent recorders out of recorders.
function modelAfterCascadeDeleteOf(name: string, before: PywrModel): PywrModel {
  return {
    ...before,
    nodes: before.nodes.filter((n) => n.name !== name),
    edges: before.edges.filter((e) => e[0] !== name && e[1] !== name),
    recorders: Object.fromEntries(
      Object.entries(before.recorders).filter(([, r]) => {
        if (r && typeof r === "object" && !Array.isArray(r)) {
          return (r as { node?: string }).node !== name;
        }
        return true;
      }),
    ),
  };
}

describe("JsonEditor — cascade visibility", () => {
  it("renders nodes, edges and recorders in the textarea on mount", () => {
    const m = modelWith3Nodes();
    render(<JsonEditor model={m} onApply={vi.fn()} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(ta.value).toContain('"Reservoir1"');
    expect(ta.value).toContain('"Link1"');
    expect(ta.value).toContain('"Demand1"');
    // Canonical Pywr edge form: arrays, not objects.
    expect(ta.value).toMatch(/"Reservoir1",\s*"Link1"/);
    expect(ta.value).toContain('"NumpyArrayNodeRecorder"');
  });

  it("reflects a cascade-delete: node, its touching edges, AND dependent recorder all disappear", () => {
    const before = modelWith3Nodes();
    const { rerender } = render(<JsonEditor model={before} onApply={vi.fn()} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    // Sanity — present before delete
    expect(ta.value).toContain('"Reservoir1"');
    expect(ta.value).toMatch(/"Reservoir1",\s*"Link1"/);
    expect(ta.value).toContain('"NumpyArrayNodeRecorder"');

    // Simulate the cascade `pywrJson.removeNode("Reservoir1")` produces
    const after = modelAfterCascadeDeleteOf("Reservoir1", before);
    rerender(<JsonEditor model={after} onApply={vi.fn()} />);

    const ta2 = screen.getByRole("textbox") as HTMLTextAreaElement;
    // Node gone
    expect(ta2.value).not.toContain('"Reservoir1"');
    // Touching edge gone (the Reservoir1 → Link1 edge)
    expect(ta2.value).not.toMatch(/"Reservoir1",\s*"Link1"/);
    // Dependent recorder gone
    expect(ta2.value).not.toContain('"NumpyArrayNodeRecorder"');
    // Untouched survivors still there
    expect(ta2.value).toContain('"Link1"');
    expect(ta2.value).toContain('"Demand1"');
    expect(ta2.value).toMatch(/"Link1",\s*"Demand1"/);
  });

  it("does NOT overwrite the user's in-progress JSON edits when the model changes (isDirty guard)", () => {
    const before = modelWith3Nodes();
    const { rerender } = render(<JsonEditor model={before} onApply={vi.fn()} />);
    const ta = screen.getByRole("textbox") as HTMLTextAreaElement;

    // Simulate user typing → JsonEditor sets isDirty internally. We mimic this
    // with a fireEvent change. After this, model→JSON sync should be paused.
    const userText = '{"hand-edited": true}';
    // Use native setter + change event to mirror real input behaviour
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value",
    )!.set!;
    setter.call(ta, userText);
    ta.dispatchEvent(new Event("input", { bubbles: true }));

    // Now re-render with a cascade-result model
    const after = modelAfterCascadeDeleteOf("Reservoir1", before);
    rerender(<JsonEditor model={after} onApply={vi.fn()} />);

    // User's text should NOT have been clobbered — they have unsaved edits
    expect(ta.value).toBe(userText);
  });
});

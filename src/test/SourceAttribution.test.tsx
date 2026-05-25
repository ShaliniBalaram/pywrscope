// src/test/SourceAttribution.test.tsx
// Component-level tests for T3.10. Pure math lives in
// sourceAttribution.test.ts; these verify the rendering contract:
// empty states, bar segments, table rows, click-through, and the
// unresolved / cycle callouts.

import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SourceAttribution } from "../components/SourceAttribution";
import type { PywrModel } from "../types/pywr";
import type { RunResultsView } from "../hooks/useRunResults";

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

function makeRunResults(nodeFlow: Record<string, number>): RunResultsView {
  const m = new Map(Object.entries(nodeFlow));
  return {
    recAgg: Object.fromEntries(Object.entries(nodeFlow).map(([k, v]) => [k, v])),
    nodeFlow: m,
    activeNodes: new Set(Array.from(m).filter(([, v]) => v > 1e-9).map(([k]) => k)),
    error: null,
  };
}

describe("<SourceAttribution>", () => {
  it("shows the empty-no-node hint when nothing is selected", () => {
    render(
      <SourceAttribution
        model={makeModel({ nodes: [], edges: [] })}
        runResults={makeRunResults({})}
        selectedNodeName={null}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/Pick a sink on the left/)).toBeInTheDocument();
  });

  it("shows the empty-no-run hint when run results are absent", () => {
    render(
      <SourceAttribution
        model={makeModel({
          nodes: [{ name: "Sink", type: "Output" }],
          edges: [],
        })}
        runResults={makeRunResults({})}
        selectedNodeName="Sink"
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/needs aggregate flow data/)).toBeInTheDocument();
  });

  it("renders one row per attributed source, sorted by share", () => {
    const model = makeModel({
      nodes: [
        { name: "SrcA", type: "Input" },
        { name: "SrcB", type: "Catchment" },
        { name: "Sink", type: "Output" },
      ],
      edges: [
        ["SrcA", "Sink"],
        ["SrcB", "Sink"],
      ],
    });
    render(
      <SourceAttribution
        model={model}
        runResults={makeRunResults({ SrcA: 8, SrcB: 2, Sink: 10 })}
        selectedNodeName="Sink"
        onSelectNode={vi.fn()}
      />,
    );
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("SrcA");
    expect(rows[0].textContent).toContain("80.0%");
    expect(rows[1].textContent).toContain("SrcB");
    expect(rows[1].textContent).toContain("20.0%");
  });

  it("invokes onSelectNode when a source row is clicked", () => {
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [
        { name: "Origin", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      edges: [["Origin", "Sink"]],
    });
    render(
      <SourceAttribution
        model={model}
        runResults={makeRunResults({ Origin: 10, Sink: 10 })}
        selectedNodeName="Sink"
        onSelectNode={onSelect}
      />,
    );
    fireEvent.click(document.querySelector("tbody tr")!);
    expect(onSelect).toHaveBeenCalledWith("Origin");
  });

  it("falls back to the 'no upstream sources' empty state when the whole share is unresolved", () => {
    // Junction is a Link with no upstream — its claim becomes unresolved.
    // With zero attributable sources, the component prefers the explicit
    // empty-state message over a 100% unresolved callout because the
    // message already explains the situation in plain language.
    const model = makeModel({
      nodes: [
        { name: "Junction", type: "Link" },
        { name: "Sink", type: "Output" },
      ],
      edges: [["Junction", "Sink"]],
    });
    render(
      <SourceAttribution
        model={model}
        runResults={makeRunResults({ Junction: 10, Sink: 10 })}
        selectedNodeName="Sink"
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/No upstream sources with recorded flow/)).toBeInTheDocument();
  });

  it("surfaces a partial-unresolved callout when some sources resolve and some leak", () => {
    // SrcA contributes 60%. The other 40% comes through a Link with no
    // upstream recorder → unresolved. The unresolved info box should appear
    // alongside the regular bar + table.
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
    render(
      <SourceAttribution
        model={model}
        runResults={makeRunResults({ SrcA: 6, BlindLink: 4, Sink: 10 })}
        selectedNodeName="Sink"
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/40.0% of the sink/)).toBeInTheDocument();
  });

  it("renders a self-attribution row when a source node is selected", () => {
    const model = makeModel({
      nodes: [{ name: "Spring", type: "Catchment" }],
      edges: [],
    });
    render(
      <SourceAttribution
        model={model}
        runResults={makeRunResults({ Spring: 50 })}
        selectedNodeName="Spring"
        onSelectNode={vi.fn()}
      />,
    );
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("Spring");
    expect(rows[0].textContent).toContain("100%");
  });
});

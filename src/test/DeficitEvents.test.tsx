// src/test/DeficitEvents.test.tsx
// Component-level tests for T3.8. Pure math lives in reliability.test.ts;
// these verify the integration: load → extract events → render → recompute
// when minDuration changes → click-through.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { DeficitEvents } from "../components/DeficitEvents";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";

function makeModel(opts: {
  nodes: Array<{ name: string; type: string; max_flow?: unknown }>;
  recorders: Record<string, unknown>;
}): PywrModel {
  return {
    nodes: opts.nodes.map((n) => {
      const node: Record<string, unknown> = { name: n.name, type: n.type };
      if (n.max_flow !== undefined) node.max_flow = n.max_flow;
      return node as unknown as PywrModel["nodes"][number];
    }),
    edges: [],
    parameters: {},
    recorders: opts.recorders as PywrModel["recorders"],
    timestepper: { start: "2024-01-01", end: "2024-12-31", timestep: 1 },
  };
}

function makeRunState(outputs: Array<{ name: string; path: string }>): RunStateView {
  return {
    status: "done",
    runId: "run-1",
    total: 30, step: 30, pct: 100, date: "2024-01-30",
    outputs, outDir: "/tmp/run",
    stats: { timesteps: 30, scenarios: 1, seconds: 0.1 },
    error: null, log: [],
  };
}

function installPywrMock(readCsvPreview: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "pywr", {
    value: {
      readCsvPreview,
      openFile: vi.fn(), openImage: vi.fn(), saveFile: vi.fn(),
      callApi: vi.fn(), saveLayoutFile: vi.fn(), readLayoutFile: vi.fn(),
      openCsv: vi.fn(), readCsvColumns: vi.fn(), openResults: vi.fn(),
      readH5List: vi.fn(), readH5Preview: vi.fn(),
      runModel: vi.fn(), onRunEvent: vi.fn(), cancelRun: vi.fn(),
      checkPython: vi.fn(), quit: vi.fn(),
    },
    writable: true,
  });
}

beforeEach(() => {
  installPywrMock(vi.fn());
});

function csvFor(values: number[]) {
  const t0 = Date.parse("2024-01-01");
  return {
    ok: true,
    headers: ["date", "scenario_0"],
    rows: values.map((v, i) => [
      new Date(t0 + i * 86_400_000).toISOString().slice(0, 10),
      String(v),
    ]),
    total_rows: values.length,
    returned_rows: values.length,
    error: null,
  };
}

describe("<DeficitEvents>", () => {
  it("shows empty hint when no demand outputs exist", () => {
    const model = makeModel({
      nodes: [{ name: "Free", type: "Output" }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Free" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <DeficitEvents
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/No Output nodes with a numeric/)).toBeInTheDocument();
  });

  it("extracts and renders events at the default 7-day minimum", async () => {
    // 14 days: 5 full, 7 dry, 2 full → exactly one 7-day event.
    const values = [
      ...Array(5).fill(10),
      ...Array(7).fill(0),
      ...Array(2).fill(10),
    ];
    installPywrMock(vi.fn().mockResolvedValue(csvFor(values)));
    const model = makeModel({
      nodes: [{ name: "DC1", type: "Output", max_flow: 10 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "DC1" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <DeficitEvents
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("7 d")).toBeInTheDocument();
    });
    // Event row carries the start and end dates.
    expect(screen.getByText("2024-01-06")).toBeInTheDocument();
    expect(screen.getByText("2024-01-12")).toBeInTheDocument();
    // Header subtitle counts 1 event.
    expect(screen.getByText(/1 event/)).toBeInTheDocument();
  });

  it("re-extracts events when the min-duration input changes (no re-read)", async () => {
    // 4-day deficit run — under default (7), shouldn't surface. Lowering
    // to 3 should reveal it; no extra CSV read should fire.
    const values = [10, 0, 0, 0, 0, 10, 10, 10];
    const reader = vi.fn().mockResolvedValue(csvFor(values));
    installPywrMock(reader);
    const model = makeModel({
      nodes: [{ name: "DC1", type: "Output", max_flow: 10 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "DC1" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <DeficitEvents
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    // Initial render: no events.
    await waitFor(() => {
      expect(screen.getByText(/No deficit runs of at least 7 days/)).toBeInTheDocument();
    });
    expect(reader).toHaveBeenCalledTimes(1);

    // Lower the threshold; the 4-day run should show up.
    const input = screen.getByLabelText(/Minimum event duration/);
    fireEvent.change(input, { target: { value: "3" } });
    await waitFor(() => {
      expect(screen.getByText("4 d")).toBeInTheDocument();
    });
    // No extra reads triggered by the duration change.
    expect(reader).toHaveBeenCalledTimes(1);
  });

  it("invokes onSelectNode when an event row is clicked", async () => {
    const values = [...Array(10).fill(0), ...Array(5).fill(10)];
    installPywrMock(vi.fn().mockResolvedValue(csvFor(values)));
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [{ name: "TargetDC", type: "Output", max_flow: 10 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "TargetDC" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <DeficitEvents
        model={model}
        runState={runState}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("10 d")).toBeInTheDocument();
    });
    // The per-DC summary strip + events table both contain TargetDC rows.
    // Click the events-table row specifically (it has "10 d" — the summary
    // strip uses "max 10d").
    const eventRow = screen.getByText("10 d").closest("tr")!;
    fireEvent.click(eventRow);
    expect(onSelect).toHaveBeenCalledWith("TargetDC");
  });

  it("renders the per-DC summary strip when events exist", async () => {
    const values = [...Array(10).fill(0), 10, 10, ...Array(8).fill(0)];
    installPywrMock(vi.fn().mockResolvedValue(csvFor(values)));
    const model = makeModel({
      nodes: [{ name: "DC1", type: "Output", max_flow: 10 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "DC1" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <DeficitEvents
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Per-demand-centre summary/)).toBeInTheDocument();
    });
    // Two events: a 10-day and an 8-day → count "2×".
    expect(screen.getByText("2×")).toBeInTheDocument();
    expect(screen.getByText("max 10d")).toBeInTheDocument();
  });
});

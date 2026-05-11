// src/test/ConcurrentFailureChart.test.tsx
// Component-level tests for T3.9. Pure math lives in reliability.test.ts;
// these verify the cross-network integration: candidate collection,
// CSV-loading, matrix derivation, header chips, and click-through.
//
// Canvas rendering is exercised but not pixel-asserted — jsdom's canvas
// stub only checks that the calls don't throw. The matrix values that
// drive the canvas are asserted via the headline chips and row labels.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { ConcurrentFailureChart } from "../components/ConcurrentFailureChart";
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
    total: 10,
    step: 10,
    pct: 100,
    date: "2024-01-10",
    outputs,
    outDir: "/tmp/run",
    stats: { timesteps: 10, scenarios: 1, seconds: 0.1 },
    error: null,
    log: [],
  };
}

function installPywrMock(readCsvPreview: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "pywr", {
    value: {
      readCsvPreview,
      openFile: vi.fn(),
      openImage: vi.fn(),
      saveFile: vi.fn(),
      callApi: vi.fn(),
      saveLayoutFile: vi.fn(),
      readLayoutFile: vi.fn(),
      openCsv: vi.fn(),
      readCsvColumns: vi.fn(),
      openResults: vi.fn(),
      readH5List: vi.fn(),
      readH5Preview: vi.fn(),
      runModel: vi.fn(),
      onRunEvent: vi.fn(),
      cancelRun: vi.fn(),
      checkPython: vi.fn(),
      quit: vi.fn(),
    },
    writable: true,
  });
}

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

beforeEach(() => {
  installPywrMock(vi.fn());
});

describe("<ConcurrentFailureChart>", () => {
  it("shows the empty hint when no numeric-demand outputs exist", () => {
    const model = makeModel({
      nodes: [{ name: "Free", type: "Output" }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Free" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <ConcurrentFailureChart
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/No Output nodes with a numeric/)).toBeInTheDocument();
  });

  it("derives peak-concurrent and day-with-any-deficit chips from loaded CSVs", async () => {
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/a.csv": csvFor([0, 0, 5, 5, 5, 5, 5, 5, 5, 5]),   // deficit days 0-1
      "/tmp/b.csv": csvFor([0, 5, 5, 5, 5, 5, 5, 5, 5, 5]),   // deficit day 0 only
      "/tmp/c.csv": csvFor([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),   // never deficit
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );
    const model = makeModel({
      nodes: [
        { name: "A", type: "Output", max_flow: 5 },
        { name: "B", type: "Output", max_flow: 5 },
        { name: "C", type: "Output", max_flow: 5 },
      ],
      recorders: {
        rec_a: { type: "NumpyArrayNodeRecorder", node: "A" },
        rec_b: { type: "NumpyArrayNodeRecorder", node: "B" },
        rec_c: { type: "NumpyArrayNodeRecorder", node: "C" },
      },
    });
    const runState = makeRunState([
      { name: "rec_a", path: "/tmp/a.csv" },
      { name: "rec_b", path: "/tmp/b.csv" },
      { name: "rec_c", path: "/tmp/c.csv" },
    ]);

    render(
      <ConcurrentFailureChart
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      // Peak concurrent = day 0 has both A and B = 2
      expect(screen.getByText("peak concurrent")).toBeInTheDocument();
    });

    // Locate the chip's value cell. We use a regex search for the count "2"
    // adjacent to the peak-concurrent label.
    const peakChip = screen.getByText("peak concurrent").parentElement!;
    expect(peakChip.textContent).toContain("2");

    // Days with any deficit = 2 (days 0 and 1). 2/10 = 20%.
    const anyChip = screen.getByText("days with any deficit").parentElement!;
    expect(anyChip.textContent).toContain("2");
    expect(anyChip.textContent).toContain("20");
  });

  it("renders row labels sorted by total deficit days descending", async () => {
    installPywrMock(
      vi.fn().mockImplementation((path: string) => {
        if (path === "/tmp/heavy.csv") return Promise.resolve(csvFor([0, 0, 0, 5, 5]));
        if (path === "/tmp/light.csv") return Promise.resolve(csvFor([0, 5, 5, 5, 5]));
        return Promise.resolve(csvFor([5, 5, 5, 5, 5]));
      }),
    );
    const model = makeModel({
      nodes: [
        { name: "Light", type: "Output", max_flow: 5 },
        { name: "Heavy", type: "Output", max_flow: 5 },
        { name: "Clean", type: "Output", max_flow: 5 },
      ],
      recorders: {
        rec_light: { type: "NumpyArrayNodeRecorder", node: "Light" },
        rec_heavy: { type: "NumpyArrayNodeRecorder", node: "Heavy" },
        rec_clean: { type: "NumpyArrayNodeRecorder", node: "Clean" },
      },
    });
    const runState = makeRunState([
      { name: "rec_light", path: "/tmp/light.csv" },
      { name: "rec_heavy", path: "/tmp/heavy.csv" },
      { name: "rec_clean", path: "/tmp/clean.csv" },
    ]);

    render(
      <ConcurrentFailureChart
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTitle(/Heavy — 3/)).toBeInTheDocument();
    });

    // Row order: Heavy (3) → Light (1) → Clean (0).
    const labels = Array.from(document.querySelectorAll('[title*="deficit day"]'))
      .map((el) => el.textContent ?? "");
    expect(labels[0]).toContain("Heavy");
    expect(labels[1]).toContain("Light");
    expect(labels[2]).toContain("Clean");
  });

  it("calls onSelectNode when a row label is clicked", async () => {
    installPywrMock(vi.fn().mockResolvedValue(csvFor([0, 0, 0, 0, 0])));
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [{ name: "Pickme", type: "Output", max_flow: 5 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Pickme" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <ConcurrentFailureChart
        model={model}
        runState={runState}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTitle(/Pickme/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTitle(/Pickme/));
    expect(onSelect).toHaveBeenCalledWith("Pickme");
  });

  it("surfaces a read-error count without aborting the matrix", async () => {
    installPywrMock(
      vi.fn().mockImplementation((path: string) => {
        if (path === "/tmp/broken.csv") {
          return Promise.resolve({
            ok: false, headers: [], rows: [], total_rows: 0, returned_rows: 0,
            error: "EACCES",
          });
        }
        return Promise.resolve(csvFor([0, 0, 5, 5, 5]));
      }),
    );
    const model = makeModel({
      nodes: [
        { name: "Ok", type: "Output", max_flow: 5 },
        { name: "Broken", type: "Output", max_flow: 5 },
      ],
      recorders: {
        rec_ok: { type: "NumpyArrayNodeRecorder", node: "Ok" },
        rec_broken: { type: "NumpyArrayNodeRecorder", node: "Broken" },
      },
    });
    const runState = makeRunState([
      { name: "rec_ok", path: "/tmp/ok.csv" },
      { name: "rec_broken", path: "/tmp/broken.csv" },
    ]);
    render(
      <ConcurrentFailureChart
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/1 read error/)).toBeInTheDocument();
    });
    // The healthy row is still represented.
    expect(screen.getByTitle(/Ok — 2/)).toBeInTheDocument();
  });
});

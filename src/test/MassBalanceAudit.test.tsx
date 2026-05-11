// src/test/MassBalanceAudit.test.tsx
// Component-level tests for T1.4. The pure math is pinned in
// src/test/massBalance.test.ts — these tests verify:
//   - collectAuditCandidates classifies recorders correctly and skips
//     irrelevant rows (internal nodes, parameter recorders, summary entry).
//   - <MassBalanceAudit> renders the right severity pill, summary cards, and
//     worst-day rows for clean / warn / violate inputs.
//   - The candidate sink row click-through fires onSelectNode.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  MassBalanceAudit,
  _internal,
} from "../components/MassBalanceAudit";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";

const { collectAuditCandidates } = _internal;

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeModel(opts: {
  nodes: Array<{ name: string; type: string }>;
  recorders: Record<string, unknown>;
}): PywrModel {
  return {
    nodes: opts.nodes.map((n) => ({ name: n.name, type: n.type } as PywrModel["nodes"][number])),
    edges: [],
    parameters: {},
    // PywrModel.recorders is Record<string, PywrRecorder>; tests pass
    // arbitrary shapes to exercise the runtime narrowing — cast through
    // the model's recorder type so the strict signature accepts them.
    recorders: opts.recorders as PywrModel["recorders"],
    timestepper: { start: "2024-01-01", end: "2024-12-31", timestep: 1 },
  };
}

function makeRunState(outputs: Array<{ name: string; path: string }>): RunStateView {
  return {
    status: "done",
    runId: "run-1",
    total: 30,
    step: 30,
    pct: 100,
    date: "2024-01-30",
    outputs,
    outDir: "/tmp/run",
    stats: { timesteps: 30, scenarios: 1, seconds: 0.1 },
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

beforeEach(() => {
  installPywrMock(vi.fn());
});

// Build a CSV preview response from a flat array of values. One scenario.
function csvFor(values: number[], startDate = "2024-01-01") {
  const t0 = Date.parse(startDate);
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

// ---------------------------------------------------------------------------
// collectAuditCandidates — pure
// ---------------------------------------------------------------------------

describe("collectAuditCandidates", () => {
  it("classifies each recorder by its node's role and drops internals", () => {
    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Catch", type: "Catchment" },
        { name: "Sink", type: "Output" },
        { name: "Lake", type: "Reservoir" },
        { name: "Pipe", type: "Link" },
      ],
      recorders: {
        rec_src:   { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_catch: { type: "NumpyArrayNodeRecorder", node: "Catch" },
        rec_sink:  { type: "NumpyArrayNodeRecorder", node: "Sink" },
        rec_lake:  { type: "NumpyArrayStorageRecorder", node: "Lake" },
        rec_pipe:  { type: "NumpyArrayNodeRecorder", node: "Pipe" },
      },
    });
    const runState = makeRunState([
      { name: "summary", path: "/tmp/summary.json" },
      { name: "rec_src",   path: "/tmp/src.csv" },
      { name: "rec_catch", path: "/tmp/catch.csv" },
      { name: "rec_sink",  path: "/tmp/sink.csv" },
      { name: "rec_lake",  path: "/tmp/lake.csv" },
      { name: "rec_pipe",  path: "/tmp/pipe.csv" },
    ]);
    const out = collectAuditCandidates(model, runState);
    // Pipe is internal — must not appear.
    expect(out.map((r) => r.recorderName).sort()).toEqual([
      "rec_catch", "rec_lake", "rec_sink", "rec_src",
    ]);
    expect(out.find((r) => r.recorderName === "rec_src")?.role).toBe("source");
    expect(out.find((r) => r.recorderName === "rec_catch")?.role).toBe("source");
    expect(out.find((r) => r.recorderName === "rec_sink")?.role).toBe("sink");
    expect(out.find((r) => r.recorderName === "rec_lake")?.role).toBe("storage");
  });

  it("skips parameter recorders and aggregate-only entries", () => {
    const model = makeModel({
      nodes: [{ name: "Src", type: "Input" }],
      recorders: {
        flow: { type: "NumpyArrayNodeRecorder", node: "Src" },
        param: { type: "NumpyArrayParameterRecorder", param: "demand" },
        agg: { type: "AggregatedRecorder", node: "Src" }, // node-bound but no CSV
      },
    });
    const runState = makeRunState([
      { name: "flow", path: "/tmp/flow.csv" },
      { name: "param", path: "/tmp/param.csv" },
    ]);
    const out = collectAuditCandidates(model, runState);
    expect(out.map((r) => r.recorderName)).toEqual(["flow"]);
  });

  it("returns [] when no source / sink / storage recorder is found", () => {
    const model = makeModel({
      nodes: [{ name: "Pipe", type: "Link" }],
      recorders: { flow: { type: "NumpyArrayNodeRecorder", node: "Pipe" } },
    });
    const runState = makeRunState([{ name: "flow", path: "/tmp/flow.csv" }]);
    expect(collectAuditCandidates(model, runState)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// <MassBalanceAudit> — integration
// ---------------------------------------------------------------------------

describe("<MassBalanceAudit>", () => {
  it("shows the empty hint when no candidate recorders exist", () => {
    const model = makeModel({
      nodes: [{ name: "Pipe", type: "Link" }],
      recorders: { flow: { type: "NumpyArrayNodeRecorder", node: "Pipe" } },
    });
    const runState = makeRunState([{ name: "flow", path: "/tmp/flow.csv" }]);
    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/No source.*sink.*storage recorders/)).toBeInTheDocument();
  });

  it("renders a 'Mass conserved' pill when inputs match outputs", async () => {
    // 10 days, source = sink = 5/day. Residual = 0.
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/src.csv": csvFor(Array(10).fill(5)),
      "/tmp/sink.csv": csvFor(Array(10).fill(5)),
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );

    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      recorders: {
        rec_src:  { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      },
    });
    const runState = makeRunState([
      { name: "rec_src",  path: "/tmp/src.csv" },
      { name: "rec_sink", path: "/tmp/sink.csv" },
    ]);

    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Mass conserved/)).toBeInTheDocument();
    });
    // Totals card: Σ inputs = 50, Σ outputs = 50. formatVolume renders
    // medium magnitudes to two decimals → "50.00".
    expect(screen.getAllByText("50.00").length).toBeGreaterThanOrEqual(2);
    // No violation callout when clean.
    expect(screen.queryByText(/candidate LP violation/)).not.toBeInTheDocument();
    // No worst-day rows table content (just the "conserves" affordance).
    expect(screen.getByText(/conserves mass per-step/)).toBeInTheDocument();
  });

  it("flags LP violations and lists worst-imbalance days", async () => {
    // 5 days, inputs 1/day, outputs [1, 1, 5, 1, 1] → big violation on day 3.
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/src.csv": csvFor([1, 1, 1, 1, 1]),
      "/tmp/sink.csv": csvFor([1, 1, 5, 1, 1]),
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );

    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      recorders: {
        rec_src:  { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      },
    });
    const runState = makeRunState([
      { name: "rec_src",  path: "/tmp/src.csv" },
      { name: "rec_sink", path: "/tmp/sink.csv" },
    ]);

    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      // Violation pill present.
      expect(screen.getByText(/LP violation \(1 day\)/)).toBeInTheDocument();
    });
    // Worst-imbalance section + at least one row visible.
    expect(screen.getByText(/Worst-imbalance days/)).toBeInTheDocument();
    expect(screen.getByText("2024-01-03")).toBeInTheDocument();
    // The violation callout explains the cases.
    expect(screen.getByText(/1 candidate LP violation/)).toBeInTheDocument();
  });

  it("clicking a worst-day row fires onSelectNode with the fallback sink", async () => {
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/src.csv": csvFor([0, 0]),
      "/tmp/sink.csv": csvFor([1, 1]),
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "OnlySink", type: "Output" },
      ],
      recorders: {
        rec_src:  { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_sink: { type: "NumpyArrayNodeRecorder", node: "OnlySink" },
      },
    });
    const runState = makeRunState([
      { name: "rec_src",  path: "/tmp/src.csv" },
      { name: "rec_sink", path: "/tmp/sink.csv" },
    ]);

    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={onSelect}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText(/2024-01-0/).length).toBeGreaterThan(0);
    });
    const firstRow = document.querySelector("tbody tr")!;
    fireEvent.click(firstRow);
    expect(onSelect).toHaveBeenCalledWith("OnlySink");
  });

  it("counts and surfaces CSV-read errors in the subtitle", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue({
        ok: false,
        headers: [],
        rows: [],
        total_rows: 0,
        returned_rows: 0,
        error: "EACCES",
      }),
    );
    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      recorders: {
        rec_src:  { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      },
    });
    const runState = makeRunState([
      { name: "rec_src",  path: "/tmp/src.csv" },
      { name: "rec_sink", path: "/tmp/sink.csv" },
    ]);

    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/2 recorder errors/)).toBeInTheDocument();
    });
  });

  it("warns (without LP violation) when residual exceeds 1% but stays positive", async () => {
    // Inputs > outputs by ~5% with no storage to absorb it. Residual flags
    // a warn, not a violation (no day has net < 0).
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/src.csv": csvFor(Array(10).fill(1.05)),
      "/tmp/sink.csv": csvFor(Array(10).fill(1)),
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );

    const model = makeModel({
      nodes: [
        { name: "Src", type: "Input" },
        { name: "Sink", type: "Output" },
      ],
      recorders: {
        rec_src:  { type: "NumpyArrayNodeRecorder", node: "Src" },
        rec_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      },
    });
    const runState = makeRunState([
      { name: "rec_src",  path: "/tmp/src.csv" },
      { name: "rec_sink", path: "/tmp/sink.csv" },
    ]);

    render(
      <MassBalanceAudit
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Imbalance/)).toBeInTheDocument();
    });
    expect(screen.queryByText(/LP violation/)).not.toBeInTheDocument();
  });
});

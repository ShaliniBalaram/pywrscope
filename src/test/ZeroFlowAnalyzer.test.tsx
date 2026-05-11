// src/test/ZeroFlowAnalyzer.test.tsx
// Tests for the zero-flow rank view (T1.3). Splits responsibility between:
//   - collectCandidates: pure helper that decides which recorder+CSV pairs
//     end up in the analyzer's input. Tested without mocking React.
//   - <ZeroFlowAnalyzer>: integration with window.pywr.readCsvPreview, sort
//     order, severity coloring, click-to-jump.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  ZeroFlowAnalyzer,
  _internal,
} from "../components/ZeroFlowAnalyzer";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";

const { collectCandidates } = _internal;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(opts: {
  nodes: Array<{ name: string; type: string }>;
  recorders: Record<string, unknown>;
}): PywrModel {
  return {
    nodes: opts.nodes.map((n) => ({ name: n.name, type: n.type } as PywrModel["nodes"][number])),
    edges: [],
    parameters: {},
    // The PywrModel.recorders type is Record<string, PywrRecorder>; tests
    // pass arbitrary shapes (including malformed values) to exercise the
    // runtime narrowing in collectCandidates, so cast through unknown here.
    recorders: opts.recorders as PywrModel["recorders"],
    timestepper: { start: "2024-01-01", end: "2024-12-31", timestep: 1 },
  };
}

function makeRunState(outputs: Array<{ name: string; path: string }>): RunStateView {
  return {
    status: "done",
    runId: "run-1",
    total: 365,
    step: 365,
    pct: 100,
    date: "2024-12-31",
    outputs,
    outDir: "/tmp/run",
    stats: { timesteps: 365, scenarios: 1, seconds: 0.5 },
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

// ---------------------------------------------------------------------------
// collectCandidates — pure
// ---------------------------------------------------------------------------

describe("collectCandidates", () => {
  it("returns one row per node-bound recorder that has a CSV path", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }, { name: "Tank", type: "Storage" }],
      recorders: {
        flow_at_sink: { type: "NumpyArrayNodeRecorder", node: "Sink" },
        storage_at_tank: { type: "NumpyArrayStorageRecorder", node: "Tank" },
      },
    });
    const runState = makeRunState([
      { name: "summary", path: "/tmp/run/summary.json" },
      { name: "flow_at_sink", path: "/tmp/run/flow_at_sink.csv" },
      { name: "storage_at_tank", path: "/tmp/run/storage_at_tank.csv" },
    ]);
    const out = collectCandidates(model, runState);
    expect(out.map((r) => r.recorderName).sort()).toEqual(["flow_at_sink", "storage_at_tank"]);
    const sink = out.find((r) => r.recorderName === "flow_at_sink")!;
    expect(sink.nodeType).toBe("Output");
    expect(sink.csvPath).toBe("/tmp/run/flow_at_sink.csv");
  });

  it("skips parameter recorders (no node binding)", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }],
      recorders: {
        flow: { type: "NumpyArrayNodeRecorder", node: "Sink" },
        param_rec: { type: "NumpyArrayParameterRecorder", param: "demand" },
      },
    });
    const runState = makeRunState([
      { name: "flow", path: "/tmp/run/flow.csv" },
      { name: "param_rec", path: "/tmp/run/param.csv" },
    ]);
    expect(collectCandidates(model, runState).map((r) => r.recorderName)).toEqual(["flow"]);
  });

  it("skips aggregate-only recorders (no CSV path was written)", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }],
      recorders: {
        agg_only: { type: "AggregatedRecorder", node: "Sink" },
        flow: { type: "NumpyArrayNodeRecorder", node: "Sink" },
      },
    });
    // agg_only has no entry in runState.outputs.
    const runState = makeRunState([{ name: "flow", path: "/tmp/run/flow.csv" }]);
    expect(collectCandidates(model, runState).map((r) => r.recorderName)).toEqual(["flow"]);
  });

  it("returns [] when the model has no recorders", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }],
      recorders: {},
    });
    const runState = makeRunState([]);
    expect(collectCandidates(model, runState)).toEqual([]);
  });

  it("tolerates malformed recorder entries", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }],
      recorders: {
        ok: { type: "NumpyArrayNodeRecorder", node: "Sink" },
        nullRec: null,
        stringRec: "not an object",
        missingNode: { type: "NumpyArrayNodeRecorder" },
      } as Record<string, unknown>,
    });
    const runState = makeRunState([{ name: "ok", path: "/tmp/run/ok.csv" }]);
    expect(collectCandidates(model, runState).map((r) => r.recorderName)).toEqual(["ok"]);
  });
});

// ---------------------------------------------------------------------------
// <ZeroFlowAnalyzer> — integration
// ---------------------------------------------------------------------------

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

describe("<ZeroFlowAnalyzer>", () => {
  it("shows an empty hint when no candidate recorders exist", () => {
    const model = makeModel({
      nodes: [{ name: "Sink", type: "Output" }],
      recorders: {},
    });
    const runState = makeRunState([]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    expect(screen.getByText(/No node-bound recorders/)).toBeInTheDocument();
  });

  it("ranks rows by zero-day count descending and color-codes severity", async () => {
    // Three recorders:
    //   - critical_rec : 40 zero days out of 60 → critical (red)
    //   - warn_rec     : 15 zero days out of 60 → warn (orange)
    //   - ok_rec       : 0 zero days  out of 60 → ok (green)
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/run/critical.csv": csvFor([
        ...Array(40).fill(0),
        ...Array(20).fill(5),
      ]),
      "/tmp/run/warn.csv": csvFor([
        ...Array(15).fill(0),
        ...Array(45).fill(5),
      ]),
      "/tmp/run/ok.csv": csvFor(Array(60).fill(5)),
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );

    const model = makeModel({
      nodes: [
        { name: "CriticalNode", type: "Output" },
        { name: "WarnNode", type: "Output" },
        { name: "OkNode", type: "Output" },
      ],
      recorders: {
        critical_rec: { type: "NumpyArrayNodeRecorder", node: "CriticalNode" },
        warn_rec: { type: "NumpyArrayNodeRecorder", node: "WarnNode" },
        ok_rec: { type: "NumpyArrayNodeRecorder", node: "OkNode" },
      },
    });
    const runState = makeRunState([
      { name: "critical_rec", path: "/tmp/run/critical.csv" },
      { name: "warn_rec", path: "/tmp/run/warn.csv" },
      { name: "ok_rec", path: "/tmp/run/ok.csv" },
    ]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      // After all three loads, every row's "zero / total" cell should be present.
      expect(screen.getByText("40 / 60")).toBeInTheDocument();
      expect(screen.getByText("15 / 60")).toBeInTheDocument();
      expect(screen.getByText("0 / 60")).toBeInTheDocument();
    });

    // Tally chips reflect the three severities (1 each).
    const criticalChip = screen.getByText(/^1 critical$/i);
    const warnChip = screen.getByText(/^1 warn$/i);
    const okChip = screen.getByText(/^1 ok$/i);
    expect(criticalChip).toBeInTheDocument();
    expect(warnChip).toBeInTheDocument();
    expect(okChip).toBeInTheDocument();

    // Row order: critical first, then warn, then ok. We inspect rendered node
    // names in their DOM order using the rows' text content.
    const rows = document.querySelectorAll("tbody tr");
    expect(rows.length).toBe(3);
    expect(rows[0].textContent).toContain("CriticalNode");
    expect(rows[1].textContent).toContain("WarnNode");
    expect(rows[2].textContent).toContain("OkNode");
  });

  it("invokes onSelectNode when a row is clicked", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue(csvFor([0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1])),
    );
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [{ name: "PickMe", type: "Output" }],
      recorders: {
        flow: { type: "NumpyArrayNodeRecorder", node: "PickMe" },
      },
    });
    const runState = makeRunState([{ name: "flow", path: "/tmp/run/flow.csv" }]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={onSelect}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("3 / 15")).toBeInTheDocument();
    });

    const row = document.querySelector("tbody tr")!;
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("PickMe");
  });

  it("filters rows by node or recorder name (case-insensitive)", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue(csvFor(Array(10).fill(1))),
    );
    const model = makeModel({
      nodes: [
        { name: "Alpha", type: "Output" },
        { name: "Beta", type: "Output" },
      ],
      recorders: {
        alpha_rec: { type: "NumpyArrayNodeRecorder", node: "Alpha" },
        beta_rec: { type: "NumpyArrayNodeRecorder", node: "Beta" },
      },
    });
    const runState = makeRunState([
      { name: "alpha_rec", path: "/tmp/run/alpha.csv" },
      { name: "beta_rec", path: "/tmp/run/beta.csv" },
    ]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(document.querySelectorAll("tbody tr").length).toBe(2);
    });

    const filter = screen.getByLabelText(/Filter zero-flow/);
    fireEvent.change(filter, { target: { value: "BETA" } });

    expect(document.querySelectorAll("tbody tr").length).toBe(1);
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
    expect(screen.getByText("Beta")).toBeInTheDocument();
  });

  it("filters out recorders with too few timesteps (aggregate-frequency style)", async () => {
    // One-row CSVs are typical of *_deficit_frequency recorders — meaningless
    // for the rank view.
    const tinyCsv = csvFor([0.42]);
    const fullCsv = csvFor(Array(30).fill(1));
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/run/tiny.csv": tinyCsv,
      "/tmp/run/full.csv": fullCsv,
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );

    const model = makeModel({
      nodes: [
        { name: "N1", type: "Output" },
        { name: "N2", type: "Output" },
      ],
      recorders: {
        tiny_rec: { type: "AggregatedFrequencyRecorder", node: "N1" },
        full_rec: { type: "NumpyArrayNodeRecorder", node: "N2" },
      },
    });
    const runState = makeRunState([
      { name: "tiny_rec", path: "/tmp/run/tiny.csv" },
      { name: "full_rec", path: "/tmp/run/full.csv" },
    ]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("0 / 30")).toBeInTheDocument();
    });

    // Header reports "1 of 2 recorders" — the tiny one was filtered out.
    expect(screen.getByText(/1 of 2 recorders/)).toBeInTheDocument();
    // tiny_rec must not appear in the visible table.
    expect(screen.queryByText("tiny_rec")).not.toBeInTheDocument();
  });

  it("surfaces CSV-read failures as an inline error cell", async () => {
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
      nodes: [{ name: "Broken", type: "Output" }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Broken" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/locked.csv" }]);

    render(
      <ZeroFlowAnalyzer
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("error")).toBeInTheDocument();
    });
    // The tally bar should report 1 error.
    expect(screen.getByText(/1 error/)).toBeInTheDocument();
  });
});

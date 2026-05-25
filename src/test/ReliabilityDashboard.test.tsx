// src/test/ReliabilityDashboard.test.tsx
// Component-level tests for T2.7. Pure math lives in reliability.test.ts;
// these verify the league-table integration: candidate collection,
// CSV-loading, sort order, parameter-row separation, click-through.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import {
  ReliabilityDashboard,
  _internal,
} from "../components/ReliabilityDashboard";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";

const { collectReliabilityCandidates } = _internal;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModel(opts: {
  nodes: Array<{ name: string; type: string; max_flow?: unknown }>;
  recorders: Record<string, unknown>;
}): PywrModel {
  return {
    nodes: opts.nodes.map((n) => {
      const node: Record<string, unknown> = { name: n.name, type: n.type };
      if (n.max_flow !== undefined) node.max_flow = n.max_flow;
      // Two-step cast via `unknown` — PywrNode is a discriminated union and
      // TS won't directly accept a Record<string, unknown> for it, even
      // though the runtime shape is identical to what other tests build.
      return node as unknown as PywrModel["nodes"][number];
    }),
    edges: [],
    parameters: {},
    // Tests pass arbitrary recorder shapes to exercise the runtime guard;
    // cast through PywrModel's strict recorder type to keep the fixtures
    // ergonomic without dropping discrimination in the production path.
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

// ---------------------------------------------------------------------------
// collectReliabilityCandidates — pure
// ---------------------------------------------------------------------------

describe("collectReliabilityCandidates", () => {
  it("returns one row per Output with numeric max_flow + a recorder", () => {
    const model = makeModel({
      nodes: [
        { name: "DemandA", type: "Output", max_flow: 10 },
        { name: "DemandB", type: "Output", max_flow: 20 },
        { name: "Source", type: "Input", max_flow: 100 },
      ],
      recorders: {
        rec_a: { type: "NumpyArrayNodeRecorder", node: "DemandA" },
        rec_b: { type: "NumpyArrayNodeRecorder", node: "DemandB" },
        rec_src: { type: "NumpyArrayNodeRecorder", node: "Source" },
      },
    });
    const runState = makeRunState([
      { name: "rec_a", path: "/tmp/a.csv" },
      { name: "rec_b", path: "/tmp/b.csv" },
      { name: "rec_src", path: "/tmp/src.csv" },
    ]);
    const out = collectReliabilityCandidates(model, runState);
    expect(out.map((r) => r.nodeName).sort()).toEqual(["DemandA", "DemandB"]);
    const a = out.find((r) => r.nodeName === "DemandA")!;
    expect(a.demandKind).toBe("numeric");
    expect(a.demand).toBe(10);
  });

  it("returns parameter-kind rows for string max_flow", () => {
    const model = makeModel({
      nodes: [
        { name: "DynamicDemand", type: "Output", max_flow: "demand_profile" },
      ],
      recorders: {
        rec: { type: "NumpyArrayNodeRecorder", node: "DynamicDemand" },
      },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    const out = collectReliabilityCandidates(model, runState);
    expect(out.length).toBe(1);
    expect(out[0].demandKind).toBe("parameter");
    expect(out[0].paramName).toBe("demand_profile");
  });

  it("skips unconstrained outputs (no max_flow)", () => {
    const model = makeModel({
      nodes: [{ name: "Open", type: "Output" }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Open" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    expect(collectReliabilityCandidates(model, runState)).toEqual([]);
  });

  it("prefers NumpyArrayNodeRecorder over a deficit recorder on the same node", () => {
    const model = makeModel({
      nodes: [{ name: "D", type: "Output", max_flow: 5 }],
      recorders: {
        deficit_rec: { type: "NumpyArrayNodeDeficitRecorder", node: "D" },
        flow_rec: { type: "NumpyArrayNodeRecorder", node: "D" },
      },
    });
    const runState = makeRunState([
      { name: "deficit_rec", path: "/tmp/def.csv" },
      { name: "flow_rec", path: "/tmp/flow.csv" },
    ]);
    const out = collectReliabilityCandidates(model, runState);
    expect(out.length).toBe(1);
    expect(out[0].recorderName).toBe("flow_rec");
  });

  it("skips outputs whose recorder has no CSV (aggregate-only)", () => {
    const model = makeModel({
      nodes: [{ name: "D", type: "Output", max_flow: 5 }],
      recorders: { rec: { type: "AggregatedRecorder", node: "D" } },
    });
    const runState = makeRunState([]); // no CSV written
    expect(collectReliabilityCandidates(model, runState)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// <ReliabilityDashboard> — integration
// ---------------------------------------------------------------------------

describe("<ReliabilityDashboard>", () => {
  it("shows the empty hint when no demand outputs exist", () => {
    const model = makeModel({
      nodes: [{ name: "Free", type: "Output" }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Free" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <ReliabilityDashboard
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/No Output nodes with a demand/)).toBeInTheDocument();
  });

  it("ranks rows by reliability ascending (worst first)", async () => {
    const csvs: Record<string, ReturnType<typeof csvFor>> = {
      "/tmp/bad.csv": csvFor([0, 0, 0, 0, 0, 0, 0, 0, 5, 5]),    // 2/10 met
      "/tmp/mid.csv": csvFor([5, 5, 5, 5, 5, 5, 0, 0, 0, 0]),    // 6/10 met
      "/tmp/good.csv": csvFor([5, 5, 5, 5, 5, 5, 5, 5, 5, 5]),   // 10/10 met
    };
    installPywrMock(
      vi.fn().mockImplementation((path: string) => Promise.resolve(csvs[path])),
    );
    const model = makeModel({
      nodes: [
        { name: "Bad", type: "Output", max_flow: 5 },
        { name: "Mid", type: "Output", max_flow: 5 },
        { name: "Good", type: "Output", max_flow: 5 },
      ],
      recorders: {
        rec_bad: { type: "NumpyArrayNodeRecorder", node: "Bad" },
        rec_mid: { type: "NumpyArrayNodeRecorder", node: "Mid" },
        rec_good: { type: "NumpyArrayNodeRecorder", node: "Good" },
      },
    });
    const runState = makeRunState([
      { name: "rec_bad", path: "/tmp/bad.csv" },
      { name: "rec_mid", path: "/tmp/mid.csv" },
      { name: "rec_good", path: "/tmp/good.csv" },
    ]);

    render(
      <ReliabilityDashboard
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("20.0%")).toBeInTheDocument();
      expect(screen.getByText("60.0%")).toBeInTheDocument();
      expect(screen.getByText("100%")).toBeInTheDocument();
    });

    // Row order: Bad first (worst), Mid, Good.
    const rows = document.querySelectorAll("tbody tr");
    expect(rows[0].textContent).toContain("Bad");
    expect(rows[1].textContent).toContain("Mid");
    expect(rows[2].textContent).toContain("Good");
  });

  it("renders a separate section for parameter-driven demands", async () => {
    installPywrMock(vi.fn().mockResolvedValue(csvFor([5, 5, 5, 5, 5])));
    const model = makeModel({
      nodes: [
        { name: "Fixed", type: "Output", max_flow: 5 },
        { name: "Dynamic", type: "Output", max_flow: "demand_profile" },
      ],
      recorders: {
        rec_fixed: { type: "NumpyArrayNodeRecorder", node: "Fixed" },
        rec_dyn: { type: "NumpyArrayNodeRecorder", node: "Dynamic" },
      },
    });
    const runState = makeRunState([
      { name: "rec_fixed", path: "/tmp/f.csv" },
      { name: "rec_dyn", path: "/tmp/d.csv" },
    ]);

    render(
      <ReliabilityDashboard
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText("100%")).toBeInTheDocument();
    });
    // Parameter section header + entry visible.
    expect(screen.getByText(/Parameter-driven demands/)).toBeInTheDocument();
    expect(screen.getByText("demand_profile")).toBeInTheDocument();
  });

  it("invokes onSelectNode when a row is clicked", async () => {
    installPywrMock(vi.fn().mockResolvedValue(csvFor([0, 0, 0, 0, 0])));
    const onSelect = vi.fn();
    const model = makeModel({
      nodes: [{ name: "TargetNode", type: "Output", max_flow: 5 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "TargetNode" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/r.csv" }]);
    render(
      <ReliabilityDashboard
        model={model}
        runState={runState}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("0%")).toBeInTheDocument();
    });
    fireEvent.click(document.querySelector("tbody tr")!);
    expect(onSelect).toHaveBeenCalledWith("TargetNode");
  });

  it("surfaces CSV-read failures as an inline error cell", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue({
        ok: false, headers: [], rows: [], total_rows: 0, returned_rows: 0,
        error: "EACCES",
      }),
    );
    const model = makeModel({
      nodes: [{ name: "Broken", type: "Output", max_flow: 5 }],
      recorders: { rec: { type: "NumpyArrayNodeRecorder", node: "Broken" } },
    });
    const runState = makeRunState([{ name: "rec", path: "/tmp/locked.csv" }]);
    render(
      <ReliabilityDashboard
        model={model}
        runState={runState}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("error")).toBeInTheDocument();
      expect(screen.getByText(/1 error/)).toBeInTheDocument();
    });
  });
});

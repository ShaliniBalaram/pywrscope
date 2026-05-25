// src/test/SankeyView.test.tsx
// Component-level tests for T2.5. Layout math lives in sankeyLayout.test.ts;
// these verify the loading contract: empty states, JSON parsing,
// graceful failure, click-through.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SankeyView } from "../components/SankeyView";
import type { RunStateView } from "../hooks/useModelRun";

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

function installPywrMock(readLayoutFile: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, "pywr", {
    value: {
      readCsvPreview: vi.fn(),
      openFile: vi.fn(),
      openImage: vi.fn(),
      saveFile: vi.fn(),
      callApi: vi.fn(),
      saveLayoutFile: vi.fn(),
      readLayoutFile,
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

describe("<SankeyView>", () => {
  it("shows the 'Sankey unavailable' hint when edge_flows isn't in outputs", () => {
    render(
      <SankeyView
        runState={makeRunState([{ name: "summary", path: "/tmp/summary.json" }])}
        onSelectNode={vi.fn()}
      />,
    );
    expect(screen.getByText(/Sankey unavailable/)).toBeInTheDocument();
  });

  it("renders the diagram when edge_flows.json contains usable edges", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue(
        JSON.stringify({
          edges: [
            { u: "Source", v: "Mid", total: 10, annual: 365 },
            { u: "Mid", v: "Sink", total: 10, annual: 365 },
          ],
          totalRoutes: 1,
          timesteps: 10,
        }),
      ),
    );
    render(
      <SankeyView
        runState={makeRunState([
          { name: "edge_flows", path: "/tmp/edge_flows.json" },
        ])}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Annual flow Sankey/)).toBeInTheDocument();
    });
    expect(screen.getByText("Source")).toBeInTheDocument();
    expect(screen.getByText("Mid")).toBeInTheDocument();
    expect(screen.getByText("Sink")).toBeInTheDocument();
  });

  it("invokes onSelectNode when a node label is clicked", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue(
        JSON.stringify({
          edges: [{ u: "A", v: "B", total: 5, annual: null }],
          totalRoutes: 1,
          timesteps: 0,
        }),
      ),
    );
    const onSelect = vi.fn();
    render(
      <SankeyView
        runState={makeRunState([
          { name: "edge_flows", path: "/tmp/edge_flows.json" },
        ])}
        onSelectNode={onSelect}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText("B")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("B"));
    expect(onSelect).toHaveBeenCalledWith("B");
  });

  it("surfaces a parse-error when edge_flows.json is malformed", async () => {
    installPywrMock(vi.fn().mockResolvedValue("{ not json"));
    render(
      <SankeyView
        runState={makeRunState([
          { name: "edge_flows", path: "/tmp/edge_flows.json" },
        ])}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/Could not read edge_flows/)).toBeInTheDocument();
    });
  });

  it("shows the 'no positive-flow edges' hint when the file is empty of usable edges", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue(
        JSON.stringify({ edges: [], totalRoutes: 0, timesteps: 0 }),
      ),
    );
    render(
      <SankeyView
        runState={makeRunState([
          { name: "edge_flows", path: "/tmp/edge_flows.json" },
        ])}
        onSelectNode={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByText(/no positive-flow edges/)).toBeInTheDocument();
    });
  });
});

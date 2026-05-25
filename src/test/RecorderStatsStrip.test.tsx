// src/test/RecorderStatsStrip.test.tsx
// Component test for the per-recorder stats strip used in the Results tab
// (T1.2). Verifies the render branches for each load state (idle, loading,
// ready, error) and that the strip pulls a CSV via window.pywr.readCsvPreview.
//
// The maths is already pinned down in recorderStats.test.ts. These tests focus
// on the wiring: which prop combination triggers which branch, and which
// labels make it into the DOM.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { RecorderStatsStrip } from "../components/RecorderStatsStrip";

// Bare-minimum window.pywr mock — RecorderStatsStrip only reads
// `readCsvPreview`. Other surface area is unused by this component, but the
// tauri_bridge type is wide so we satisfy it with no-op vi.fns.
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

describe("RecorderStatsStrip — idle (no CSV)", () => {
  it("renders nothing when csvPath is null (aggregate-only recorder)", () => {
    const { container } = render(
      <RecorderStatsStrip
        csvPath={null}
        recorderName="agg_rec"
        recorderType="AggregatedRecorder"
      />,
    );
    // Strip should be invisible — both the loading hint and the stats grid
    // are suppressed for aggregate-only recorders.
    expect(container.firstChild).toBeNull();
  });
});

describe("RecorderStatsStrip — happy path", () => {
  it("loads CSV, computes stats, and renders all five cells", async () => {
    // 4 rows × 1 scenario: [5, 0, 10, 5]. mean=5, max=10, zero=1, total=4, pct=75%
    const readCsvPreview = vi.fn().mockResolvedValue({
      ok: true,
      headers: ["date", "scenario_0"],
      rows: [
        ["2024-01-01", "5"],
        ["2024-01-02", "0"],
        ["2024-01-03", "10"],
        ["2024-01-04", "5"],
      ],
      total_rows: 4,
      returned_rows: 4,
      error: null,
    });
    installPywrMock(readCsvPreview);

    render(
      <RecorderStatsStrip
        csvPath="/tmp/run/flow.csv"
        recorderName="flow_rec"
        recorderType="NumpyArrayNodeRecorder"
      />,
    );

    // While loading we get the placeholder text.
    expect(screen.getByText(/loading stats/)).toBeInTheDocument();

    await waitFor(() => {
      // After load, all five stat labels are present.
      expect(screen.getByText("mean")).toBeInTheDocument();
      expect(screen.getByText("max")).toBeInTheDocument();
      expect(screen.getByText("zero days")).toBeInTheDocument();
      expect(screen.getByText("% active")).toBeInTheDocument();
      expect(screen.getByText("annual")).toBeInTheDocument();
    });

    expect(readCsvPreview).toHaveBeenCalledWith("/tmp/run/flow.csv", 200_000);

    // Values: mean=5 → "5.00", max=10 → "10.00", zero=1/4, %active=75%
    expect(screen.getByText("5.00")).toBeInTheDocument();
    expect(screen.getByText("10.00")).toBeInTheDocument();
    expect(screen.getByText("1 / 4")).toBeInTheDocument();
    expect(screen.getByText("75.0%")).toBeInTheDocument();
  });
});

describe("RecorderStatsStrip — error path", () => {
  it("renders an inline error message when readCsvPreview reports failure", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue({
        ok: false,
        headers: [],
        rows: [],
        total_rows: 0,
        returned_rows: 0,
        error: "Permission denied",
      }),
    );

    render(
      <RecorderStatsStrip
        csvPath="/tmp/locked.csv"
        recorderName="locked_rec"
        recorderType="NumpyArrayNodeRecorder"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/stats unavailable/)).toBeInTheDocument();
    });
    // Underlying error message is surfaced via tooltip (title attribute).
    const errorEl = screen.getByText(/stats unavailable/);
    expect(errorEl.getAttribute("title")).toContain("Permission denied");
  });

  it("renders an inline error when CSV has no scenario columns", async () => {
    installPywrMock(
      vi.fn().mockResolvedValue({
        ok: true,
        headers: ["date"], // missing scenario columns
        rows: [["2024-01-01"]],
        total_rows: 1,
        returned_rows: 1,
        error: null,
      }),
    );

    render(
      <RecorderStatsStrip
        csvPath="/tmp/broken.csv"
        recorderName="broken_rec"
        recorderType="X"
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/stats unavailable/)).toBeInTheDocument();
    });
  });
});

describe("RecorderStatsStrip — reload on prop change", () => {
  it("re-fetches when csvPath changes (new run produces a new path)", async () => {
    // Series 1: [3, 3] → mean=3, max=3 (both display "3.00").
    // Series 2: [9, 9] → mean=9, max=9 (both display "9.00").
    // Using two cells per series with the same value is fine — getAllByText
    // is used in assertions to avoid the "multiple matches" failure mode of
    // getByText when both mean and max coincide.
    const readCsvPreview = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        headers: ["date", "scenario_0"],
        rows: [["2024-01-01", "3"], ["2024-01-02", "3"]],
        total_rows: 2,
        returned_rows: 2,
        error: null,
      })
      .mockResolvedValueOnce({
        ok: true,
        headers: ["date", "scenario_0"],
        rows: [["2024-06-01", "9"], ["2024-06-02", "9"]],
        total_rows: 2,
        returned_rows: 2,
        error: null,
      });
    installPywrMock(readCsvPreview);

    const { rerender } = render(
      <RecorderStatsStrip
        csvPath="/tmp/run1/flow.csv"
        recorderName="flow"
        recorderType="NumpyArrayNodeRecorder"
      />,
    );

    await waitFor(() => {
      // Both mean and max are "3.00" — getAllByText guards against any future
      // change that adds/removes one of those slots without breaking the test.
      expect(screen.getAllByText("3.00").length).toBeGreaterThanOrEqual(1);
    });

    rerender(
      <RecorderStatsStrip
        csvPath="/tmp/run2/flow.csv"
        recorderName="flow"
        recorderType="NumpyArrayNodeRecorder"
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByText("9.00").length).toBeGreaterThanOrEqual(1);
    });

    expect(readCsvPreview).toHaveBeenCalledTimes(2);
  });
});

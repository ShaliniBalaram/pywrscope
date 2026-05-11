// src/components/NodeTimeSeriesChart.tsx
// Per-node time series chart for the Results tab.
//
// Given the recorder CSVs for a node (path comes from runState.outputs), draws
// one SVG line chart per recorder with reference lines for numeric node
// fields (max_flow, min_flow, cost). Used to replace per-node dropdown plots
// from the analyst notebook with a single click-through view.
//
// Design choices:
//   - Inline SVG, no plotting library. The project ships zero render-side
//     deps; adding Plotly/d3/recharts for a single chart is not justified
//     when the math fits in ~100 lines.
//   - Whole-series read via readCsvPreview with a generous maxRows cap. The
//     Rust side already scans the whole file to compute total_rows, so the
//     marginal cost of returning all rows is one allocation, not one I/O.
//   - One <svg> per recorder rather than one combined chart: recorders bound
//     to the same node can record physically distinct quantities (flow vs
//     deficit vs storage), and overlaying them would mislead.
//   - Hover crosshair is rendered in React state (not DOM mutation) so it
//     stays consistent with re-renders triggered by series changes.
//
// CSV contract (set by src-tauri/python/run_pywr.py):
//   first column: ISO date
//   columns 1..N: scenario_0..scenario_{N-1} (numeric, may be empty)
//
// What the chart does NOT do (deferred to T1.2+):
//   - Aggregate statistics (mean/max/zero-days)
//   - Sub-period zoom / pan
//   - Export to PNG / CSV (the underlying CSV is already on disk)

import React, { useEffect, useMemo, useRef, useState } from "react";

// Generous upper bound. A 100-year daily run = 36,525 rows; this cap covers
// hourly runs over decades. We still want a cap so a pathological file
// (millions of rows) can't lock the renderer.
const MAX_ROWS = 200_000;

const W = 820;
const H = 260;
const PAD_L = 64;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 36;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

// Palette for scenario lines. Up to 6 distinct hues; beyond that we cycle.
// Pywr models with >6 scenarios are uncommon and the chart already shows the
// scenario index in the tooltip, so cycling is acceptable.
const SCENARIO_COLORS = [
  "#1d4ed8", // blue
  "#059669", // emerald
  "#b45309", // amber
  "#7c3aed", // violet
  "#db2777", // pink
  "#0e7490", // cyan
];

export interface ChartRecorderRef {
  recorderName: string;
  type: string;
  // null = recorder is aggregate-only or its file wasn't written. Component
  // renders an informational row in that case rather than failing silently.
  csvPath: string | null;
}

export interface ChartRefLine {
  // e.g. "max_flow", "min_flow", "cost". Used as the on-chart label.
  label: string;
  value: number;
  color: string;
}

interface Series {
  recorderName: string;
  recorderType: string;
  dates: string[];
  // values[rowIdx][scenarioIdx]. NaN where the source CSV had a blank cell.
  values: number[][];
  scenarioCount: number;
  yMin: number;
  yMax: number;
}

// Exported for unit tests. Pure: takes the CSV preview shape and returns the
// Series (or an error). Keeping it pure means the SVG layer never has to
// reason about parsing, only drawing.
export function parseCsvSeries(
  recorderName: string,
  recorderType: string,
  headers: string[],
  rows: (string | number)[][],
): { series: Series | null; error: string | null } {
  if (headers.length < 2) {
    return { series: null, error: "CSV has no scenario columns" };
  }
  const scenarioCount = headers.length - 1;
  const dates: string[] = [];
  const values: number[][] = [];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const row of rows) {
    dates.push(String(row[0] ?? ""));
    const vs: number[] = new Array(scenarioCount);
    for (let i = 0; i < scenarioCount; i++) {
      const raw = row[i + 1];
      // Treat blank / whitespace-only cells as missing. Number("") returns 0
      // in JavaScript, which would silently fake a zero data point; that's a
      // worse failure mode than a visible gap on the chart.
      let n: number;
      if (typeof raw === "number") {
        n = raw;
      } else if (typeof raw === "string" && raw.trim() === "") {
        n = NaN;
      } else {
        n = Number(raw);
      }
      if (Number.isFinite(n)) {
        vs[i] = n;
        if (n < yMin) yMin = n;
        if (n > yMax) yMax = n;
      } else {
        vs[i] = NaN;
      }
    }
    values.push(vs);
  }
  if (!Number.isFinite(yMin) || !Number.isFinite(yMax)) {
    return { series: null, error: "No finite values in series" };
  }
  return {
    series: { recorderName, recorderType, dates, values, scenarioCount, yMin, yMax },
    error: null,
  };
}

// Expand the [min,max] window to include reference-line values and add a
// small pad so lines don't sit on the frame edge. Pure; tested separately.
export function paddedDomain(
  yMin: number,
  yMax: number,
  refLines: ChartRefLine[],
): { lo: number; hi: number } {
  let lo = yMin;
  let hi = yMax;
  for (const r of refLines) {
    if (Number.isFinite(r.value)) {
      if (r.value < lo) lo = r.value;
      if (r.value > hi) hi = r.value;
    }
  }
  if (lo === hi) {
    // Flat series: synthesise a band so the line isn't drawn on the axis.
    const eps = Math.abs(lo) > 0 ? Math.abs(lo) * 0.05 : 1;
    return { lo: lo - eps, hi: hi + eps };
  }
  const pad = (hi - lo) * 0.08;
  return { lo: lo - pad, hi: hi + pad };
}

// Linearly distributed tick values; 5 ticks reads cleanly at 260px height
// without crowding scenario lines.
function yTicks(lo: number, hi: number, count = 5): number[] {
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    out.push(lo + ((hi - lo) * i) / (count - 1));
  }
  return out;
}

function formatTick(v: number): string {
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// Build the SVG path for one scenario. NaN values are gap-friendly: a run of
// finite points becomes its own connected sub-path, so missing rows don't
// fake a connection across the gap.
function buildPath(
  series: Series,
  scenarioIdx: number,
  xs: (i: number) => number,
  ys: (v: number) => number,
): string {
  const parts: string[] = [];
  let pen = false;
  for (let i = 0; i < series.dates.length; i++) {
    const v = series.values[i][scenarioIdx];
    if (!Number.isFinite(v)) {
      pen = false;
      continue;
    }
    parts.push(`${pen ? "L" : "M"} ${xs(i).toFixed(2)} ${ys(v).toFixed(2)}`);
    pen = true;
  }
  return parts.join(" ");
}

interface NodeTimeSeriesChartProps {
  nodeName: string;
  recorders: ChartRecorderRef[];
  refLines: ChartRefLine[];
}

// Top-level component. Loads all recorder CSVs once on mount (or whenever the
// recorder list identity changes), then delegates each recorder's render to
// <RecorderChart> so the hover-state of one doesn't re-render the others.
export function NodeTimeSeriesChart({
  nodeName,
  recorders,
  refLines,
}: NodeTimeSeriesChartProps) {
  const [seriesByName, setSeriesByName] = useState<Map<string, Series>>(new Map());
  const [errorsByName, setErrorsByName] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);

  // Stable key for the effect: recorder list serialised. New runs produce new
  // CSV paths even if names match (different outDir), so the path must be in
  // the key to trigger a reload.
  const key = useMemo(
    () => recorders.map((r) => `${r.recorderName}|${r.csvPath ?? ""}`).join("\n"),
    [recorders],
  );

  useEffect(() => {
    const loadable = recorders.filter((r) => r.csvPath);
    if (loadable.length === 0) {
      setSeriesByName(new Map());
      setErrorsByName(new Map());
      return;
    }
    let cancelled = false;
    setLoading(true);
    (async () => {
      const seriesMap = new Map<string, Series>();
      const errMap = new Map<string, string>();
      for (const r of loadable) {
        const res = await window.pywr.readCsvPreview(r.csvPath!, MAX_ROWS);
        if (cancelled) return;
        if (!res.ok) {
          errMap.set(r.recorderName, res.error ?? "Could not read CSV");
          continue;
        }
        const parsed = parseCsvSeries(r.recorderName, r.type, res.headers, res.rows);
        if (parsed.error || !parsed.series) {
          errMap.set(r.recorderName, parsed.error ?? "Empty series");
          continue;
        }
        seriesMap.set(r.recorderName, parsed.series);
      }
      if (cancelled) return;
      setSeriesByName(seriesMap);
      setErrorsByName(errMap);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (recorders.length === 0) {
    return (
      <div style={hintStyle}>
        No recorder bound to <strong>{nodeName}</strong>. Add a
        NumpyArrayNodeRecorder (or storage variant) in the model to capture
        its time series.
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={titleRowStyle}>
        <div style={{ fontSize: 12, fontWeight: 700, color: "#0f172a", textTransform: "uppercase", letterSpacing: 0.5 }}>
          Time series — {nodeName}
        </div>
        {loading && (
          <div style={{ fontSize: 11, color: "#64748b" }}>loading…</div>
        )}
      </div>
      {recorders.map((r) => {
        const s = seriesByName.get(r.recorderName);
        const err = errorsByName.get(r.recorderName);
        return (
          <RecorderChart
            key={r.recorderName}
            recorder={r}
            series={s ?? null}
            error={err ?? null}
            refLines={refLines}
          />
        );
      })}
    </div>
  );
}

// Per-recorder sub-chart. Owns its own hover index so cursor movement over
// one chart doesn't re-render its siblings.
function RecorderChart({
  recorder,
  series,
  error,
  refLines,
}: {
  recorder: ChartRecorderRef;
  series: Series | null;
  error: string | null;
  refLines: ChartRefLine[];
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  if (recorder.csvPath === null) {
    return (
      <div style={chartCardStyle}>
        <ChartCaption recorder={recorder} />
        <div style={emptyChartStyle}>
          Recorder is aggregate-only (no per-step CSV). See the summary value
          in the Downstream panel below.
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div style={chartCardStyle}>
        <ChartCaption recorder={recorder} />
        <div style={errorChartStyle}>{error}</div>
      </div>
    );
  }

  if (!series) {
    return (
      <div style={chartCardStyle}>
        <ChartCaption recorder={recorder} />
        <div style={emptyChartStyle}>Loading…</div>
      </div>
    );
  }

  const { lo, hi } = paddedDomain(series.yMin, series.yMax, refLines);
  const n = series.dates.length;
  const xs = (i: number) =>
    PAD_L + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const ys = (v: number) =>
    PAD_T + PLOT_H - ((v - lo) / (hi - lo || 1)) * PLOT_H;

  const ticks = yTicks(lo, hi);

  // x-axis labels: start, mid, end. Three is enough at 800px width and avoids
  // collisions on dense series.
  const xLabels = n === 0
    ? []
    : n === 1
      ? [{ x: xs(0), label: series.dates[0] }]
      : [
          { x: xs(0), label: series.dates[0] },
          { x: xs(Math.floor((n - 1) / 2)), label: series.dates[Math.floor((n - 1) / 2)] },
          { x: xs(n - 1), label: series.dates[n - 1] },
        ];

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    // Map screen px to SVG user units (viewBox is 0..W).
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < PAD_L || px > PAD_L + PLOT_W) {
      setHoverIdx(null);
      return;
    }
    const t = (px - PAD_L) / PLOT_W;
    const idx = Math.round(t * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  const onMouseLeave = () => setHoverIdx(null);

  return (
    <div style={chartCardStyle}>
      <ChartCaption recorder={recorder} series={series} />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ display: "block", background: "#fff" }}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        role="img"
        aria-label={`Time series for ${recorder.recorderName}`}
      >
        {/* Plot frame */}
        <rect
          x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H}
          fill="#fafafa" stroke="#e2e8f0"
        />

        {/* Y gridlines + tick labels */}
        {ticks.map((t, i) => {
          const y = ys(t);
          return (
            <g key={i}>
              <line
                x1={PAD_L} x2={PAD_L + PLOT_W} y1={y} y2={y}
                stroke="#e2e8f0" strokeDasharray="2 4"
              />
              <text
                x={PAD_L - 6} y={y + 3}
                textAnchor="end" fontSize={10} fill="#64748b"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {formatTick(t)}
              </text>
            </g>
          );
        })}

        {/* X axis labels */}
        {xLabels.map((l, i) => (
          <text
            key={i} x={l.x} y={PAD_T + PLOT_H + 16}
            textAnchor={i === 0 ? "start" : i === xLabels.length - 1 ? "end" : "middle"}
            fontSize={10} fill="#64748b"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {l.label}
          </text>
        ))}

        {/* Reference lines (max_flow etc.) — drawn before series so series sits on top */}
        {refLines.map((r, i) => {
          if (!Number.isFinite(r.value)) return null;
          if (r.value < lo || r.value > hi) return null;
          const y = ys(r.value);
          return (
            <g key={i}>
              <line
                x1={PAD_L} x2={PAD_L + PLOT_W} y1={y} y2={y}
                stroke={r.color} strokeWidth={1} strokeDasharray="6 4"
              />
              <text
                x={PAD_L + PLOT_W - 4} y={y - 3}
                textAnchor="end" fontSize={10} fill={r.color}
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {r.label} = {formatTick(r.value)}
              </text>
            </g>
          );
        })}

        {/* Scenario lines */}
        {Array.from({ length: series.scenarioCount }, (_, sIdx) => (
          <path
            key={sIdx}
            d={buildPath(series, sIdx, xs, ys)}
            fill="none"
            stroke={SCENARIO_COLORS[sIdx % SCENARIO_COLORS.length]}
            strokeWidth={1.4}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        ))}

        {/* Hover crosshair */}
        {hoverIdx !== null && (
          <g pointerEvents="none">
            <line
              x1={xs(hoverIdx)} x2={xs(hoverIdx)}
              y1={PAD_T} y2={PAD_T + PLOT_H}
              stroke="#94a3b8" strokeDasharray="3 3"
            />
            {Array.from({ length: series.scenarioCount }, (_, sIdx) => {
              const v = series.values[hoverIdx][sIdx];
              if (!Number.isFinite(v)) return null;
              return (
                <circle
                  key={sIdx}
                  cx={xs(hoverIdx)} cy={ys(v)} r={3}
                  fill={SCENARIO_COLORS[sIdx % SCENARIO_COLORS.length]}
                  stroke="#fff" strokeWidth={1}
                />
              );
            })}
          </g>
        )}
      </svg>

      {/* Readout strip */}
      <div style={readoutStyle}>
        {hoverIdx === null ? (
          <span style={{ color: "#94a3b8" }}>Hover the chart to read values.</span>
        ) : (
          <>
            <span style={{ color: "#0f172a", fontWeight: 600 }}>
              {series.dates[hoverIdx]}
            </span>
            {Array.from({ length: series.scenarioCount }, (_, sIdx) => {
              const v = series.values[hoverIdx][sIdx];
              return (
                <span key={sIdx} style={{
                  display: "inline-flex", alignItems: "center", gap: 4,
                  color: "#334155", marginLeft: 12,
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: 4, display: "inline-block",
                    background: SCENARIO_COLORS[sIdx % SCENARIO_COLORS.length],
                  }} />
                  <span style={{ fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
                    {series.scenarioCount === 1 ? "value" : `s${sIdx}`} = {Number.isFinite(v) ? formatTick(v) : "—"}
                  </span>
                </span>
              );
            })}
          </>
        )}
      </div>
    </div>
  );
}

function ChartCaption({
  recorder,
  series,
}: {
  recorder: ChartRecorderRef;
  series?: Series | null;
}) {
  return (
    <div style={{
      display: "flex", justifyContent: "space-between", alignItems: "baseline",
      padding: "6px 10px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc",
    }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
        {recorder.recorderName}
      </div>
      <div style={{ fontSize: 10, color: "#64748b" }}>
        {recorder.type}
        {series && (
          <>
            {" · "}{series.dates.length.toLocaleString()} steps
            {series.scenarioCount > 1 && <> · {series.scenarioCount} scenarios</>}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const chartCardStyle: React.CSSProperties = {
  marginBottom: 12,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
};

const titleRowStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  marginBottom: 8,
};

const emptyChartStyle: React.CSSProperties = {
  padding: 18, fontSize: 12, color: "#64748b", textAlign: "center",
};

const errorChartStyle: React.CSSProperties = {
  padding: 12, fontSize: 12, color: "#991b1b",
  background: "#fef2f2", borderTop: "1px solid #fee2e2",
};

const readoutStyle: React.CSSProperties = {
  padding: "6px 12px", fontSize: 11, color: "#64748b",
  borderTop: "1px solid #e2e8f0", background: "#f8fafc",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const hintStyle: React.CSSProperties = {
  padding: 14, marginBottom: 18,
  background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6,
  color: "#92400e", fontSize: 12,
};

// Exported for unit tests — see src/test/NodeTimeSeriesChart.test.ts
export const _internal = { parseCsvSeries, paddedDomain, yTicks, buildPath, formatTick };

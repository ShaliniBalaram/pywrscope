// src/components/ConcurrentFailureChart.tsx
// T3.9 — concurrent-failure timeseries.
//
// For every Output node with a numeric demand, count how many are in deficit
// on each timestep. The headline question this view answers:
//
//   "Are our failures clustered into drought events, or are they evenly
//    sprinkled across the horizon?"
//
// A clustered profile points at a system-wide drought. An evenly-distributed
// one points at an under-sized individual demand (or a misconfigured cost).
// The two have very different remediation paths, so distinguishing them at a
// glance is worth its own tab.
//
// Rendering:
//   1. Line chart of `perDayCount` — inline SVG, same vocabulary as
//      NodeTimeSeriesChart. Reference line at peakConcurrent for context.
//   2. Heatmap of (Output × date), red where the cell is in deficit, neutral
//      for "met" and grey for "no data". Drawn into a <canvas> rather than
//      SVG rects — a 100-year daily run with 50 demand centres is 1.8M cells
//      and SVG will choke. Canvas keeps the draw under a few ms.
//
// CSV reads and candidate collection are shared with ReliabilityDashboard —
// any Output with a numeric `max_flow` and a node-bound recorder is in scope.
// Parameter-driven demands are skipped because we can't resolve their target
// without parameter evaluation (same constraint as the reliability dashboard).
//
// What it doesn't do (deferred):
//   - Doesn't merge mismatched run horizons. Rows whose dates don't match the
//     reference timeline are dropped and the count is shown in the header.
//   - Doesn't drill into individual events — DeficitEvents (T3.8) already
//     enumerates per-node events; this view's contribution is the
//     cross-network correlation.

import React, { useEffect, useMemo, useRef, useState } from "react";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  DEFICIT_SENTINEL_FAIL,
  DEFICIT_SENTINEL_NO_DATA,
  buildConcurrentFailureMatrix,
  computeDeficitIndicator,
  type ConcurrentFailureMatrix,
  type ConcurrentFailureRow,
} from "../lib/reliability";
import { collectReliabilityCandidates } from "./ReliabilityDashboard";

const MAX_ROWS = 200_000;

// Heatmap canvas size. Width is the SVG/document width budget; the canvas DPR
// is applied internally so the bitmap is crisp on Retina. Per-row height is
// clamped so a model with two demands doesn't render a 200px-tall band, and a
// model with two hundred demands doesn't render a hairline.
const CANVAS_W = 920;
const ROW_H_MIN = 4;
const ROW_H_PREFERRED = 12;
const ROW_H_MAX = 18;

// Line chart geometry — mirrors NodeTimeSeriesChart so the two views feel
// like one family.
const LINE_W = CANVAS_W;
const LINE_H = 140;
const PAD_L = 60;
const PAD_R = 16;
const PAD_T = 14;
const PAD_B = 30;
const PLOT_W = LINE_W - PAD_L - PAD_R;
const PLOT_H = LINE_H - PAD_T - PAD_B;

// Heatmap colour stops. We use a 4-step ramp instead of a continuous gradient
// because each cell is one of three discrete states (deficit / met / no data)
// — a gradient would imply finer granularity than we actually compute.
const COLOR_DEFICIT = "#dc2626"; // red-600
const COLOR_MET = "#ecfdf5";     // emerald-50 (very faint green; reads as "ok")
const COLOR_NO_DATA = "#e5e7eb"; // neutral-200
const COLOR_GRID = "#cbd5e1";    // slate-300, used for row separators

interface ConcurrentFailureChartProps {
  model: PywrModel;
  runState: RunStateView;
  onSelectNode: (name: string) => void;
}

interface LoaderRow extends ConcurrentFailureRow {
  // Empty indicator + zero dates marks "still loading or failed". Errors are
  // surfaced in a separate list so the header can show their count.
  error: string | null;
}

export function ConcurrentFailureChart({
  model,
  runState,
  onSelectNode,
}: ConcurrentFailureChartProps) {
  // Reuse the reliability dashboard's candidate collection — same eligibility
  // rule (Output + numeric max_flow + node-bound recorder with a CSV). We
  // filter out parameter-driven rows here because there's no path to resolve
  // their threshold and they'd otherwise show up as "no data" stripes,
  // confusing the read.
  const candidates = useMemo(
    () =>
      collectReliabilityCandidates(model, runState).filter(
        (c) => c.demandKind === "numeric",
      ),
    [model, runState],
  );

  const [rows, setRows] = useState<LoaderRow[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Same cache-key idiom as the rest of the Results tab — a new run = new
  // CSV paths = new fetch.
  const cacheKey = useMemo(
    () => candidates.map((c) => `${c.recorderName}|${c.csvPath}`).join("\n"),
    [candidates],
  );

  useEffect(() => {
    if (candidates.length === 0) {
      setRows([]);
      setLoadedCount(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadedCount(0);
    const seed: LoaderRow[] = candidates.map((c) => ({
      nodeName: c.nodeName,
      recorderName: c.recorderName,
      dates: [],
      indicator: new Int8Array(0),
      error: null,
    }));
    setRows(seed);

    (async () => {
      const work = candidates.map(async (c, idx) => {
        try {
          const res = await window.pywr.readCsvPreview(c.csvPath, MAX_ROWS);
          if (cancelled) return;
          if (!res.ok) {
            setRows((prev) =>
              updateRow(prev, idx, { error: res.error ?? "Could not read CSV" }),
            );
            return;
          }
          const parsed = parseCsvSeries(
            c.recorderName,
            c.recorderType,
            res.headers,
            res.rows,
          );
          if (parsed.error || !parsed.series) {
            setRows((prev) =>
              updateRow(prev, idx, { error: parsed.error ?? "Empty series" }),
            );
            return;
          }
          const indicator = computeDeficitIndicator(parsed.series.values, c.demand);
          setRows((prev) =>
            updateRow(prev, idx, {
              dates: parsed.series!.dates,
              indicator,
            }),
          );
        } catch (e) {
          if (cancelled) return;
          setRows((prev) =>
            updateRow(prev, idx, {
              error: e instanceof Error ? e.message : String(e),
            }),
          );
        } finally {
          if (!cancelled) setLoadedCount((n) => n + 1);
        }
      });
      await Promise.allSettled(work);
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Build the matrix from rows whose indicators have finished loading. Empty
  // indicators (still loading or errored) are skipped so partial loads still
  // produce a coherent view.
  const matrix = useMemo<ConcurrentFailureMatrix>(() => {
    const loaded: ConcurrentFailureRow[] = rows
      .filter((r) => !r.error && r.indicator.length > 0)
      .map((r) => ({
        nodeName: r.nodeName,
        recorderName: r.recorderName,
        dates: r.dates,
        indicator: r.indicator,
      }));
    return buildConcurrentFailureMatrix(loaded);
  }, [rows]);

  const errorCount = useMemo(
    () => rows.reduce((n, r) => (r.error ? n + 1 : n), 0),
    [rows],
  );

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        No Output nodes with a numeric <code>max_flow</code> and a node-bound
        recorder were found. Concurrent-failure analysis needs at least two
        demand centres to be interesting. Add <code>max_flow</code> +
        <code>NumpyArrayNodeRecorder</code> to your demand nodes, then re-run.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Header
        matrix={matrix}
        candidateCount={candidates.length}
        loadedCount={loadedCount}
        loading={loading}
        errorCount={errorCount}
      />
      <div style={bodyStyle}>
        {matrix.nodes.length === 0 ? (
          <div style={pendingStyle}>
            {loading
              ? "Loading recorder CSVs…"
              : "No deficit-eligible recorders aligned to a common timeline."}
          </div>
        ) : (
          <>
            <ConcurrentLineChart matrix={matrix} />
            <HeatmapBoard matrix={matrix} onSelectNode={onSelectNode} />
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  matrix,
  candidateCount,
  loadedCount,
  loading,
  errorCount,
}: {
  matrix: ConcurrentFailureMatrix;
  candidateCount: number;
  loadedCount: number;
  loading: boolean;
  errorCount: number;
}) {
  // Share of timesteps with at least one deficit. Useful one-glance number:
  // a clustered drought has a low share but high peak, while a chronic
  // under-supply has a high share at a low peak.
  const horizon = matrix.dates.length;
  const anyDeficitDays = useMemo(() => {
    let n = 0;
    for (const c of matrix.perDayCount) if (c > 0) n++;
    return n;
  }, [matrix.perDayCount]);
  const sharePct = horizon === 0 ? 0 : (anyDeficitDays / horizon) * 100;

  return (
    <div style={headerStyle}>
      <div style={titleStyle}>Concurrent failures</div>
      <div style={subtitleStyle}>
        {matrix.nodes.length} demand centre{matrix.nodes.length === 1 ? "" : "s"}
        {horizon > 0 && ` · ${horizon.toLocaleString()} timesteps`}
        {loading && ` · loaded ${loadedCount}/${candidateCount}`}
        {errorCount > 0 && (
          <span style={{ color: "#991b1b" }}>
            {" "}· {errorCount} read error{errorCount === 1 ? "" : "s"}
          </span>
        )}
        {matrix.droppedRows > 0 && (
          <span style={{ color: "#a16207" }}>
            {" "}· {matrix.droppedRows} row{matrix.droppedRows === 1 ? "" : "s"} dropped (timeline mismatch)
          </span>
        )}
      </div>
      <div style={chipRowStyle}>
        <StatChip
          label="peak concurrent"
          value={matrix.peakConcurrent.toLocaleString()}
          tone={matrix.peakConcurrent === 0 ? "neutral" : "alarm"}
        />
        <StatChip
          label="days with any deficit"
          value={`${anyDeficitDays.toLocaleString()} (${formatSharePct(sharePct)})`}
          tone={anyDeficitDays === 0 ? "neutral" : "warn"}
        />
        {matrix.peakConcurrent > 0 && matrix.worstDayIndex >= 0 && (
          <StatChip
            label="peak day"
            value={matrix.dates[matrix.worstDayIndex]}
            tone="neutral"
          />
        )}
      </div>
    </div>
  );
}

function StatChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "neutral" | "warn" | "alarm";
}) {
  const color =
    tone === "alarm" ? "#dc2626" : tone === "warn" ? "#d97706" : "#475569";
  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        padding: "4px 10px",
        borderRadius: 6,
        border: `1px solid ${color}33`,
        background: `${color}0d`,
        minWidth: 90,
      }}
    >
      <span
        style={{
          fontSize: 9,
          color,
          textTransform: "uppercase",
          letterSpacing: 0.5,
          fontWeight: 700,
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 13,
          color: "#0f172a",
          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
          fontWeight: 600,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function formatSharePct(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (v >= 99.95) return "100%";
  if (v <= 0.05) return "0%";
  return `${v.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Line chart — concurrent deficit count per timestep
// ---------------------------------------------------------------------------

function ConcurrentLineChart({ matrix }: { matrix: ConcurrentFailureMatrix }) {
  const n = matrix.dates.length;
  const yMax = Math.max(1, matrix.peakConcurrent);
  const xs = (i: number) =>
    PAD_L + (n <= 1 ? PLOT_W / 2 : (i / (n - 1)) * PLOT_W);
  const ys = (v: number) => PAD_T + PLOT_H - (v / yMax) * PLOT_H;

  // Build a single path with NaN-friendly gaps. We don't have gaps here (count
  // is always a finite int) but keep the same shape as NodeTimeSeriesChart for
  // future-proofing if we add a "no data" floor.
  const path = useMemo(() => {
    if (n === 0) return "";
    const parts: string[] = [];
    for (let i = 0; i < n; i++) {
      parts.push(`${i === 0 ? "M" : "L"} ${xs(i).toFixed(2)} ${ys(matrix.perDayCount[i]).toFixed(2)}`);
    }
    return parts.join(" ");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matrix.perDayCount, n, yMax]);

  // Y ticks at integer counts. For a small peak (≤8) we tick every unit;
  // beyond that we step by ceil(peak/5) to avoid label crowding.
  const yTicks = useMemo(() => {
    if (yMax <= 8) {
      const out: number[] = [];
      for (let i = 0; i <= yMax; i++) out.push(i);
      return out;
    }
    const step = Math.ceil(yMax / 5);
    const out: number[] = [];
    for (let v = 0; v <= yMax; v += step) out.push(v);
    if (out[out.length - 1] !== yMax) out.push(yMax);
    return out;
  }, [yMax]);

  const xLabels = useMemo(() => {
    if (n === 0) return [] as Array<{ x: number; label: string; anchor: "start" | "middle" | "end" }>;
    if (n === 1) return [{ x: xs(0), label: matrix.dates[0], anchor: "middle" as const }];
    const mid = Math.floor((n - 1) / 2);
    return [
      { x: xs(0), label: matrix.dates[0], anchor: "start" as const },
      { x: xs(mid), label: matrix.dates[mid], anchor: "middle" as const },
      { x: xs(n - 1), label: matrix.dates[n - 1], anchor: "end" as const },
    ];
  }, [matrix.dates, n]);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || n === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * LINE_W;
    if (px < PAD_L || px > PAD_L + PLOT_W) {
      setHoverIdx(null);
      return;
    }
    const t = (px - PAD_L) / PLOT_W;
    const idx = Math.round(t * (n - 1));
    setHoverIdx(Math.max(0, Math.min(n - 1, idx)));
  };

  return (
    <div style={chartCardStyle}>
      <div style={chartCaptionStyle}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
          Demand centres in deficit per timestep
        </div>
        <div style={{ fontSize: 10, color: "#64748b" }}>
          peak = {matrix.peakConcurrent.toLocaleString()} / {matrix.nodes.length}
        </div>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${LINE_W} ${LINE_H}`}
        width="100%"
        height={LINE_H}
        style={{ display: "block", background: "#fff" }}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHoverIdx(null)}
        role="img"
        aria-label="Concurrent deficit count per timestep"
      >
        <rect
          x={PAD_L}
          y={PAD_T}
          width={PLOT_W}
          height={PLOT_H}
          fill="#fafafa"
          stroke="#e2e8f0"
        />
        {/* Y ticks + gridlines */}
        {yTicks.map((t) => {
          const y = ys(t);
          return (
            <g key={t}>
              <line
                x1={PAD_L}
                x2={PAD_L + PLOT_W}
                y1={y}
                y2={y}
                stroke="#e2e8f0"
                strokeDasharray="2 4"
              />
              <text
                x={PAD_L - 6}
                y={y + 3}
                textAnchor="end"
                fontSize={10}
                fill="#64748b"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                {t}
              </text>
            </g>
          );
        })}
        {/* Peak marker reference line */}
        {matrix.peakConcurrent > 0 && (
          <g>
            <line
              x1={PAD_L}
              x2={PAD_L + PLOT_W}
              y1={ys(matrix.peakConcurrent)}
              y2={ys(matrix.peakConcurrent)}
              stroke={COLOR_DEFICIT}
              strokeWidth={1}
              strokeDasharray="6 4"
            />
            <text
              x={PAD_L + PLOT_W - 4}
              y={ys(matrix.peakConcurrent) - 3}
              textAnchor="end"
              fontSize={10}
              fill={COLOR_DEFICIT}
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              peak = {matrix.peakConcurrent}
            </text>
          </g>
        )}
        {/* X axis labels */}
        {xLabels.map((l, i) => (
          <text
            key={i}
            x={l.x}
            y={PAD_T + PLOT_H + 16}
            textAnchor={l.anchor}
            fontSize={10}
            fill="#64748b"
            fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
          >
            {l.label}
          </text>
        ))}
        <path
          d={path}
          fill="none"
          stroke={COLOR_DEFICIT}
          strokeWidth={1.4}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {/* Hover crosshair */}
        {hoverIdx !== null && (
          <g pointerEvents="none">
            <line
              x1={xs(hoverIdx)}
              x2={xs(hoverIdx)}
              y1={PAD_T}
              y2={PAD_T + PLOT_H}
              stroke="#94a3b8"
              strokeDasharray="3 3"
            />
            <circle
              cx={xs(hoverIdx)}
              cy={ys(matrix.perDayCount[hoverIdx])}
              r={3}
              fill={COLOR_DEFICIT}
              stroke="#fff"
              strokeWidth={1}
            />
          </g>
        )}
      </svg>
      <div style={readoutStyle}>
        {hoverIdx === null ? (
          <span style={{ color: "#94a3b8" }}>
            Hover the chart to read the per-timestep concurrent-deficit count.
          </span>
        ) : (
          <>
            <span style={{ color: "#0f172a", fontWeight: 600 }}>
              {matrix.dates[hoverIdx]}
            </span>
            <span style={{ color: "#334155", marginLeft: 12 }}>
              concurrent ={" "}
              <span style={{ fontWeight: 600, color: COLOR_DEFICIT }}>
                {matrix.perDayCount[hoverIdx]}
              </span>{" "}
              / {matrix.nodes.length}
            </span>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Heatmap — Output × date, deficit-coloured
// ---------------------------------------------------------------------------

function HeatmapBoard({
  matrix,
  onSelectNode,
}: {
  matrix: ConcurrentFailureMatrix;
  onSelectNode: (name: string) => void;
}) {
  // Row height clamped so 2 rows don't render giant and 200 rows don't render
  // hairline-thin. The component's outer scroll handles overflow when there
  // are more rows than the preferred height supports.
  const rowH = Math.min(
    ROW_H_MAX,
    Math.max(ROW_H_MIN, ROW_H_PREFERRED),
  );

  return (
    <div style={chartCardStyle}>
      <div style={chartCaptionStyle}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
          Deficit heatmap (sorted worst → best)
        </div>
        <div style={{ fontSize: 10, color: "#64748b", display: "flex", gap: 12 }}>
          <LegendSwatch color={COLOR_DEFICIT} label="deficit" />
          <LegendSwatch color={COLOR_MET} label="met" />
          <LegendSwatch color={COLOR_NO_DATA} label="no data" />
        </div>
      </div>
      <div style={heatmapScrollStyle}>
        <HeatmapCanvas matrix={matrix} rowH={rowH} onSelectNode={onSelectNode} />
      </div>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span
        style={{
          width: 10,
          height: 10,
          background: color,
          border: "1px solid #cbd5e1",
          display: "inline-block",
        }}
      />
      {label}
    </span>
  );
}

function HeatmapCanvas({
  matrix,
  rowH,
  onSelectNode,
}: {
  matrix: ConcurrentFailureMatrix;
  rowH: number;
  onSelectNode: (name: string) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Label gutter on the left for node names. Width is generous so long names
  // truncate gracefully rather than overflow into the heatmap.
  const LABEL_W = 200;
  const heatW = CANVAS_W - LABEL_W;
  const n = matrix.nodes.length;
  const cols = matrix.dates.length;
  const heatH = n * rowH;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || cols === 0 || n === 0) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(heatW * dpr);
    canvas.height = Math.floor(heatH * dpr);
    canvas.style.width = `${heatW}px`;
    canvas.style.height = `${heatH}px`;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // Pure background — pre-fills "met" so we only have to draw deficit + no-
    // data cells. Big win for the common case where most cells are green.
    ctx.fillStyle = COLOR_MET;
    ctx.fillRect(0, 0, heatW, heatH);

    // Column-bin when there are more dates than horizontal pixels — without
    // this the canvas just oversamples the last cell per pixel column and
    // loses visual density. We collapse each bin to "deficit if any cell in
    // the bin was a deficit", which is the conservative read for spotting
    // events.
    const pxPerCol = heatW / cols;
    if (pxPerCol >= 1) {
      // Each date is at least one pixel wide — draw cells directly.
      for (let r = 0; r < n; r++) {
        const row = matrix.matrix[r];
        for (let c = 0; c < cols; c++) {
          const s = row[c];
          if (s === DEFICIT_SENTINEL_FAIL) {
            ctx.fillStyle = COLOR_DEFICIT;
            ctx.fillRect(c * pxPerCol, r * rowH, Math.max(1, pxPerCol), rowH);
          } else if (s === DEFICIT_SENTINEL_NO_DATA) {
            ctx.fillStyle = COLOR_NO_DATA;
            ctx.fillRect(c * pxPerCol, r * rowH, Math.max(1, pxPerCol), rowH);
          }
        }
      }
    } else {
      // More dates than pixels — bin. Each px column draws the max-severity
      // state seen in its bin (deficit beats no-data beats met).
      const colsPerPx = cols / heatW;
      for (let r = 0; r < n; r++) {
        const row = matrix.matrix[r];
        for (let px = 0; px < heatW; px++) {
          const start = Math.floor(px * colsPerPx);
          const end = Math.min(cols, Math.floor((px + 1) * colsPerPx));
          let any = DEFICIT_SENTINEL_NO_DATA - 1; // sentinel "nothing seen"
          let sawDeficit = false;
          let sawNoData = false;
          let sawMet = false;
          for (let c = start; c < end; c++) {
            const s = row[c];
            if (s === DEFICIT_SENTINEL_FAIL) { sawDeficit = true; break; }
            if (s === DEFICIT_SENTINEL_NO_DATA) sawNoData = true;
            else sawMet = true;
          }
          if (sawDeficit) {
            ctx.fillStyle = COLOR_DEFICIT;
            ctx.fillRect(px, r * rowH, 1, rowH);
          } else if (sawNoData && !sawMet) {
            ctx.fillStyle = COLOR_NO_DATA;
            ctx.fillRect(px, r * rowH, 1, rowH);
          }
          // else: met — already painted in the background fill.
          // any is unused; kept to make the binning logic explicit.
          void any;
        }
      }
    }

    // Row separator hairlines — only when rowH ≥ 6 (smaller and they crowd
    // the colour band).
    if (rowH >= 6) {
      ctx.fillStyle = COLOR_GRID;
      for (let r = 1; r < n; r++) {
        ctx.fillRect(0, r * rowH - 0.5, heatW, 1);
      }
    }
  }, [matrix, rowH, heatW, heatH, cols, n]);

  // Tooltip on hover: which node and date is under the cursor.
  const [tip, setTip] = useState<{
    x: number;
    y: number;
    node: string;
    date: string;
    state: "deficit" | "met" | "no-data";
    total: number;
  } | null>(null);

  const onMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const rect = target.getBoundingClientRect();
    const x = e.clientX - rect.left - LABEL_W;
    const y = e.clientY - rect.top;
    if (x < 0 || x >= heatW || y < 0 || y >= heatH || cols === 0 || n === 0) {
      setTip(null);
      return;
    }
    const r = Math.min(n - 1, Math.max(0, Math.floor(y / rowH)));
    const c = Math.min(cols - 1, Math.max(0, Math.floor((x / heatW) * cols)));
    const s = matrix.matrix[r][c];
    setTip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      node: matrix.nodes[r],
      date: matrix.dates[c],
      state:
        s === DEFICIT_SENTINEL_FAIL
          ? "deficit"
          : s === DEFICIT_SENTINEL_NO_DATA
          ? "no-data"
          : "met",
      total: matrix.perNodeTotals[r],
    });
  };

  const onMouseLeave = () => setTip(null);

  // Click a row label → jump to the per-node Downstream view.
  return (
    <div
      style={{
        position: "relative",
        width: CANVAS_W,
        // Use the natural heatH so the parent's scroll handles overflow when
        // many rows are present.
        height: heatH,
        display: "flex",
      }}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
    >
      <div style={{ width: LABEL_W, flexShrink: 0 }}>
        {matrix.nodes.map((name, i) => (
          <div
            key={name}
            onClick={() => onSelectNode(name)}
            title={`${name} — ${matrix.perNodeTotals[i].toLocaleString()} deficit day${matrix.perNodeTotals[i] === 1 ? "" : "s"}. Click to inspect.`}
            style={{
              height: rowH,
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              fontSize: Math.min(11, rowH - 1),
              color: "#0f172a",
              borderBottom: rowH >= 6 ? "1px solid #f1f5f9" : "none",
              cursor: "pointer",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              background: i % 2 === 0 ? "#fff" : "#fafafa",
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis" }}>
              {name}
            </span>
            <span
              style={{
                marginLeft: 6,
                color: matrix.perNodeTotals[i] > 0 ? COLOR_DEFICIT : "#94a3b8",
                fontWeight: 600,
              }}
            >
              {matrix.perNodeTotals[i]}
            </span>
          </div>
        ))}
      </div>
      <canvas
        ref={canvasRef}
        style={{
          display: "block",
          width: heatW,
          height: heatH,
          borderLeft: "1px solid #e2e8f0",
          cursor: "crosshair",
        }}
      />
      {tip && (
        <div
          style={{
            position: "absolute",
            left: Math.min(tip.x + 12, CANVAS_W - 220),
            top: Math.max(0, tip.y - 36),
            background: "rgba(15,23,42,0.92)",
            color: "#f8fafc",
            padding: "4px 8px",
            borderRadius: 4,
            fontSize: 11,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            pointerEvents: "none",
            whiteSpace: "nowrap",
            zIndex: 10,
          }}
        >
          <div style={{ fontWeight: 600 }}>{tip.node}</div>
          <div>
            {tip.date} — <span style={{ color: tip.state === "deficit" ? "#fca5a5" : tip.state === "no-data" ? "#cbd5e1" : "#bbf7d0" }}>{tip.state}</span>
          </div>
          <div style={{ color: "#cbd5e1" }}>{tip.total} total deficit day{tip.total === 1 ? "" : "s"}</div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function updateRow(prev: LoaderRow[], idx: number, patch: Partial<LoaderRow>): LoaderRow[] {
  if (idx < 0 || idx >= prev.length) return prev;
  const next = prev.slice();
  next[idx] = { ...prev[idx], ...patch };
  return next;
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
  display: "flex",
  flexDirection: "column",
  gap: 8,
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const chipRowStyle: React.CSSProperties = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 16,
  background: "#f8fafc",
};

const chartCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
  marginBottom: 12,
};

const chartCaptionStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  padding: "6px 12px",
  borderBottom: "1px solid #e2e8f0",
  background: "#f8fafc",
};

const readoutStyle: React.CSSProperties = {
  padding: "6px 12px",
  fontSize: 11,
  color: "#64748b",
  borderTop: "1px solid #e2e8f0",
  background: "#f8fafc",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const heatmapScrollStyle: React.CSSProperties = {
  // The canvas itself fits CANVAS_W exactly; horizontal scroll handles tiny
  // viewports gracefully. Vertical scroll handles tall heatmaps when there
  // are many demand centres.
  overflow: "auto",
  maxHeight: 480,
  background: "#fff",
};

const pendingStyle: React.CSSProperties = {
  padding: 24,
  textAlign: "center",
  color: "#64748b",
  fontSize: 12,
  background: "#fff",
  borderRadius: 6,
  border: "1px solid #e2e8f0",
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: 13,
  padding: 24,
  textAlign: "center",
};

// Exported for unit tests — lets the test suite drive the component without
// re-implementing the candidate collection.
export const _internal = { LABEL_W: 200, CANVAS_W, ROW_H_PREFERRED };

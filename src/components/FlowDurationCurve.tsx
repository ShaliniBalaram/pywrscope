// src/components/FlowDurationCurve.tsx
// Per-recorder flow-duration-curve (T2.6) shown below the time-series chart
// in the Results tab's downstream view.
//
// Reads the same CSVs as NodeTimeSeriesChart (one parallel load each — no
// caching layer is shared yet between the two). Renders one SVG curve per
// recorder with hover crosshair and Q10/Q50/Q90 reference markers.
//
// Design notes:
//   - Pure math in src/lib/flowDuration.ts. This file is presentation only.
//   - One <svg> per recorder, same approach as NodeTimeSeriesChart. Combining
//     recorders that record physically distinct quantities (flow vs deficit
//     vs storage) onto a shared y-axis would mislead the user.
//   - X axis is "exceedance probability" (0..1) — labelled with %. Y axis is
//     flow magnitude. Standard hydrology orientation.
//   - We deliberately don't reuse NodeTimeSeriesChart internals. They're
//     coupled to (date, value) ordering; FDC is (exceedance, flow). Trying
//     to share would add abstraction tax for no payoff.

import React, { useEffect, useMemo, useRef, useState } from "react";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import {
  computeFlowDuration,
  flowAtExceedance,
  STANDARD_EXCEEDANCE_QUANTILES,
  type FlowDurationPoint,
} from "../lib/flowDuration";

const MAX_ROWS = 200_000;

// Same canvas dimensions as the time-series chart so the two stack cleanly.
const W = 820;
const H = 240;
const PAD_L = 64;
const PAD_R = 14;
const PAD_T = 14;
const PAD_B = 36;
const PLOT_W = W - PAD_L - PAD_R;
const PLOT_H = H - PAD_T - PAD_B;

export interface FlowDurationCurveProps {
  nodeName: string;
  recorders: { recorderName: string; type: string; csvPath: string | null }[];
}

interface FdcSeries {
  recorderName: string;
  recorderType: string;
  points: FlowDurationPoint[];
  // Derived once: flows at standard exceedance quantiles for the readout.
  quantiles: { p: number; q: number }[];
  yMin: number;
  yMax: number;
}

export function FlowDurationCurve({ nodeName, recorders }: FlowDurationCurveProps) {
  const [seriesByName, setSeriesByName] = useState<Map<string, FdcSeries>>(new Map());
  const [errorsByName, setErrorsByName] = useState<Map<string, string>>(new Map());
  const [loading, setLoading] = useState(false);

  // Same cache-key shape as NodeTimeSeriesChart so the two reload in lockstep
  // when paths change.
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
      const seriesMap = new Map<string, FdcSeries>();
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
        const points = computeFlowDuration(parsed.series.values);
        if (points.length === 0) {
          errMap.set(r.recorderName, "No finite values to plot");
          continue;
        }
        const yMax = points[0].flow; // sorted desc — first is max
        const yMin = points[points.length - 1].flow;
        const quantiles = STANDARD_EXCEEDANCE_QUANTILES.map((p) => ({
          p,
          q: flowAtExceedance(points, p),
        }));
        seriesMap.set(r.recorderName, {
          recorderName: r.recorderName,
          recorderType: r.type,
          points,
          quantiles,
          yMin,
          yMax,
        });
      }
      if (cancelled) return;
      setSeriesByName(seriesMap);
      setErrorsByName(errMap);
      setLoading(false);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (recorders.length === 0) return null;

  return (
    <div style={{ marginBottom: 18 }}>
      <div style={titleRowStyle}>
        <div style={titleStyle}>Flow-duration curve — {nodeName}</div>
        {loading && <div style={loadingStyle}>loading…</div>}
      </div>
      {recorders.map((r) => {
        const s = seriesByName.get(r.recorderName);
        const err = errorsByName.get(r.recorderName);
        return (
          <FdcCard
            key={r.recorderName}
            recorderName={r.recorderName}
            recorderType={r.type}
            series={s ?? null}
            error={err ?? null}
            csvPath={r.csvPath}
          />
        );
      })}
    </div>
  );
}

// Per-recorder card. Owns its own hover state so cursor movement on one
// curve doesn't re-render its siblings — same idiom as RecorderChart.
function FdcCard({
  recorderName,
  recorderType,
  series,
  error,
  csvPath,
}: {
  recorderName: string;
  recorderType: string;
  series: FdcSeries | null;
  error: string | null;
  csvPath: string | null;
}) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<FlowDurationPoint | null>(null);

  if (csvPath === null) {
    return (
      <div style={cardStyle}>
        <Caption recorderName={recorderName} recorderType={recorderType} />
        <div style={hintStyle}>
          Recorder is aggregate-only (no per-step CSV) — no FDC to plot.
        </div>
      </div>
    );
  }
  if (error) {
    return (
      <div style={cardStyle}>
        <Caption recorderName={recorderName} recorderType={recorderType} />
        <div style={errorStyle}>{error}</div>
      </div>
    );
  }
  if (!series) {
    return (
      <div style={cardStyle}>
        <Caption recorderName={recorderName} recorderType={recorderType} />
        <div style={hintStyle}>Loading…</div>
      </div>
    );
  }

  // y-axis: pad 5% so the line doesn't hug the frame.
  const lo = series.yMin;
  const hi = series.yMax;
  // Flat series guard — synthesise a tiny band so the line is visible.
  const yLo = lo === hi ? lo - (Math.abs(lo) * 0.05 || 1) : lo - (hi - lo) * 0.05;
  const yHi = lo === hi ? hi + (Math.abs(hi) * 0.05 || 1) : hi + (hi - lo) * 0.05;
  const xs = (e: number) => PAD_L + e * PLOT_W; // exceedance is already [0,1]
  const ys = (v: number) =>
    PAD_T + PLOT_H - ((v - yLo) / (yHi - yLo || 1)) * PLOT_H;

  // Build the SVG path. Points are already sorted by ascending exceedance.
  const d = series.points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xs(p.exceedance).toFixed(2)} ${ys(p.flow).toFixed(2)}`)
    .join(" ");

  const onMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg || series.points.length === 0) return;
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    if (px < PAD_L || px > PAD_L + PLOT_W) {
      setHover(null);
      return;
    }
    const frac = (px - PAD_L) / PLOT_W;
    // Find the closest point by exceedance; cheaper than interpolating since
    // FDC has at most ~200k points and the array is sorted.
    let lo = 0;
    let hi = series.points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (series.points[mid].exceedance < frac) lo = mid + 1;
      else hi = mid;
    }
    setHover(series.points[lo]);
  };

  return (
    <div style={cardStyle}>
      <Caption
        recorderName={recorderName}
        recorderType={recorderType}
        sampleCount={series.points.length}
      />
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        style={{ display: "block", background: "#fff" }}
        onMouseMove={onMouseMove}
        onMouseLeave={() => setHover(null)}
        role="img"
        aria-label={`Flow-duration curve for ${recorderName}`}
      >
        {/* Frame */}
        <rect
          x={PAD_L} y={PAD_T} width={PLOT_W} height={PLOT_H}
          fill="#fafafa" stroke="#e2e8f0"
        />

        {/* X gridlines at 0, 25, 50, 75, 100% */}
        {[0, 0.25, 0.5, 0.75, 1].map((g, i) => (
          <g key={i}>
            <line
              x1={xs(g)} x2={xs(g)} y1={PAD_T} y2={PAD_T + PLOT_H}
              stroke="#e2e8f0" strokeDasharray="2 4"
            />
            <text
              x={xs(g)} y={PAD_T + PLOT_H + 16}
              textAnchor={i === 0 ? "start" : i === 4 ? "end" : "middle"}
              fontSize={10} fill="#64748b"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {Math.round(g * 100)}%
            </text>
          </g>
        ))}

        {/* Y ticks (5 evenly spaced) */}
        {[0, 0.25, 0.5, 0.75, 1].map((t, i) => {
          const v = yLo + (yHi - yLo) * t;
          const y = ys(v);
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
                {formatTick(v)}
              </text>
            </g>
          );
        })}

        {/* Standard quantile reference lines (Q10, Q50, Q90) — visually
            de-emphasised so the curve itself dominates. */}
        {series.quantiles
          .filter((q) => q.p === 0.1 || q.p === 0.5 || q.p === 0.9)
          .map((q) => (
            <g key={q.p}>
              <line
                x1={xs(q.p)} x2={xs(q.p)}
                y1={PAD_T} y2={PAD_T + PLOT_H}
                stroke="#94a3b8" strokeDasharray="4 4" strokeWidth={1}
              />
              <text
                x={xs(q.p) + 4} y={PAD_T + 12}
                fontSize={9} fill="#475569"
                fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
              >
                Q{Math.round(q.p * 100)}
              </text>
            </g>
          ))}

        {/* The curve itself. */}
        <path d={d} fill="none" stroke="#1d4ed8" strokeWidth={1.6}
              strokeLinejoin="round" strokeLinecap="round" />

        {/* Hover crosshair + dot */}
        {hover !== null && (
          <g pointerEvents="none">
            <line
              x1={xs(hover.exceedance)} x2={xs(hover.exceedance)}
              y1={PAD_T} y2={PAD_T + PLOT_H}
              stroke="#94a3b8" strokeDasharray="3 3"
            />
            <circle
              cx={xs(hover.exceedance)} cy={ys(hover.flow)} r={3.5}
              fill="#1d4ed8" stroke="#fff" strokeWidth={1.2}
            />
          </g>
        )}
      </svg>

      <div style={readoutStyle}>
        {hover === null ? (
          <>
            <span style={readoutLabelStyle}>Q10</span>
            <span style={readoutValueStyle}>{formatTick(series.quantiles[1].q)}</span>
            <span style={readoutLabelStyle}>Q50</span>
            <span style={readoutValueStyle}>{formatTick(series.quantiles[2].q)}</span>
            <span style={readoutLabelStyle}>Q90</span>
            <span style={readoutValueStyle}>{formatTick(series.quantiles[3].q)}</span>
            <span style={{ ...readoutLabelStyle, marginLeft: "auto", color: "#94a3b8" }}>
              hover for any point
            </span>
          </>
        ) : (
          <>
            <span style={readoutLabelStyle}>exceedance</span>
            <span style={readoutValueStyle}>{(hover.exceedance * 100).toFixed(1)}%</span>
            <span style={readoutLabelStyle}>flow</span>
            <span style={readoutValueStyle}>{formatTick(hover.flow)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function Caption({
  recorderName,
  recorderType,
  sampleCount,
}: {
  recorderName: string;
  recorderType: string;
  sampleCount?: number;
}) {
  return (
    <div style={captionStyle}>
      <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
        {recorderName}
      </div>
      <div style={{ fontSize: 10, color: "#64748b" }}>
        {recorderType}
        {typeof sampleCount === "number" && (
          <> · {sampleCount.toLocaleString()} samples ranked</>
        )}
      </div>
    </div>
  );
}

function formatTick(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e6 || abs < 1e-3) return v.toExponential(2);
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const cardStyle: React.CSSProperties = {
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

const titleStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, color: "#0f172a",
  textTransform: "uppercase", letterSpacing: 0.5,
};

const loadingStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b",
};

const captionStyle: React.CSSProperties = {
  display: "flex", justifyContent: "space-between", alignItems: "baseline",
  padding: "6px 10px", borderBottom: "1px solid #e2e8f0", background: "#f8fafc",
};

const hintStyle: React.CSSProperties = {
  padding: 18, fontSize: 12, color: "#64748b", textAlign: "center",
};

const errorStyle: React.CSSProperties = {
  padding: 12, fontSize: 12, color: "#991b1b",
  background: "#fef2f2", borderTop: "1px solid #fee2e2",
};

const readoutStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 8,
  padding: "6px 12px", fontSize: 11, color: "#64748b",
  borderTop: "1px solid #e2e8f0", background: "#f8fafc",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const readoutLabelStyle: React.CSSProperties = {
  color: "#64748b", fontWeight: 500,
};

const readoutValueStyle: React.CSSProperties = {
  color: "#0f172a", fontWeight: 600, marginRight: 8,
};

// Exported for tests.
export const _internal = { formatTick };

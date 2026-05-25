// src/components/DeficitEvents.tsx
// T3.8 — Engineering Drought Order (EDO) style event log + per-DC severity
// summary. For every demand centre (Output node with numeric max_flow),
// decompose the run into consecutive-deficit events of duration ≥ N
// (configurable, default 7) and surface them as a sortable table plus a
// per-DC summary strip (count · mean duration · max duration).
//
// Why a separate component from ReliabilityDashboard:
//   - Reliability answers "what fraction of time did this DC fail?".
//   - Events answer "when did it fail, for how long, and how bad were the
//     individual drought episodes?".
//   - Same input (per-node flow CSV + demand) but different output shape:
//     reliability collapses to a scalar; events list discrete records.
//
// Shares collectReliabilityCandidates with ReliabilityDashboard since the
// candidate set is identical. Importing the helper avoids re-implementing
// the recorder selection logic.

import React, { useEffect, useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import { parseCsvSeries } from "./NodeTimeSeriesChart";
import { _internal as reliabilityInternal } from "./ReliabilityDashboard";
import {
  DEFAULT_MIN_EVENT_DAYS,
  extractDeficitEvents,
  summariseEvents,
  type DeficitEvent,
  type EventSummary,
} from "../lib/reliability";
import { formatVolume } from "../lib/massBalance";

const MAX_ROWS = 200_000;

const { collectReliabilityCandidates } = reliabilityInternal;

// One demand centre after CSV load + event extraction.
interface DcRow {
  nodeName: string;
  recorderName: string;
  csvPath: string;
  demand: number;
  // null = not loaded yet
  events: DeficitEvent[] | null;
  summary: EventSummary | null;
  error: string | null;
}

interface DeficitEventsProps {
  model: PywrModel;
  runState: RunStateView;
  onSelectNode: (name: string) => void;
}

export function DeficitEvents({
  model,
  runState,
  onSelectNode,
}: DeficitEventsProps) {
  // Min-duration is user-controlled because what counts as a "real" drought
  // event varies by domain — water resources reports often use 7 or 14 days,
  // licence-cap analyses use 30. Default matches the notebook.
  const [minDuration, setMinDuration] = useState<number>(DEFAULT_MIN_EVENT_DAYS);

  // Re-use the reliability dashboard's candidate set. Filter to numeric
  // demand only — parameter-driven outputs can't be evaluated for events
  // without resolving the parameter time series.
  const candidates = useMemo(
    () => collectReliabilityCandidates(model, runState).filter((c) => c.demandKind === "numeric"),
    [model, runState],
  );

  const [rows, setRows] = useState<DcRow[]>([]);
  const [loadedCount, setLoadedCount] = useState(0);
  const [loading, setLoading] = useState(false);

  // Reload only when CSV paths change (new run), NOT when minDuration changes
  // — recomputing events from already-parsed series is cheap and avoids
  // re-reading the disk just because the user nudged a number input.
  const cacheKey = useMemo(
    () => candidates.map((c) => `${c.recorderName}|${c.csvPath}`).join("\n"),
    [candidates],
  );

  // Cache parsed values per row index so the minDuration change can
  // recompute events without re-parsing. Stored alongside the row.
  type ParsedCache = { values: number[][]; dates: string[] };
  const [parsedByIdx, setParsedByIdx] = useState<Map<number, ParsedCache>>(new Map());

  useEffect(() => {
    if (candidates.length === 0) {
      setRows([]);
      setParsedByIdx(new Map());
      setLoadedCount(0);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setLoadedCount(0);
    const seed: DcRow[] = candidates.map((c) => ({
      nodeName: c.nodeName,
      recorderName: c.recorderName,
      csvPath: c.csvPath,
      demand: c.demand,
      events: null,
      summary: null,
      error: null,
    }));
    setRows(seed);
    const parsedMap = new Map<number, ParsedCache>();

    (async () => {
      const work = candidates.map(async (c, idx) => {
        try {
          const res = await window.pywr.readCsvPreview(c.csvPath, MAX_ROWS);
          if (cancelled) return;
          if (!res.ok) {
            setRows((prev) => updateRow(prev, idx, {
              error: res.error ?? "Could not read CSV",
            }));
            return;
          }
          const parsed = parseCsvSeries(c.recorderName, "", res.headers, res.rows);
          if (parsed.error || !parsed.series) {
            setRows((prev) => updateRow(prev, idx, {
              error: parsed.error ?? "Empty series",
            }));
            return;
          }
          parsedMap.set(idx, {
            values: parsed.series.values,
            dates: parsed.series.dates,
          });
          // Compute events with the CURRENT minDuration (whatever state is
          // at this moment). The minDuration-effect below recomputes for
          // every row after this when the user changes the input.
          const events = extractDeficitEvents(
            parsed.series.values,
            parsed.series.dates,
            c.demand,
            { minDuration },
          );
          setRows((prev) => updateRow(prev, idx, {
            events,
            summary: summariseEvents(events),
          }));
        } catch (e) {
          if (cancelled) return;
          setRows((prev) => updateRow(prev, idx, {
            error: e instanceof Error ? e.message : String(e),
          }));
        } finally {
          if (!cancelled) setLoadedCount((n) => n + 1);
        }
      });
      await Promise.allSettled(work);
      if (!cancelled) {
        setParsedByIdx(parsedMap);
        setLoading(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // Recompute events whenever minDuration changes WITHOUT re-reading the
  // CSVs. Skips work when parsedByIdx is empty (initial render or loading).
  useEffect(() => {
    if (parsedByIdx.size === 0) return;
    setRows((prev) => prev.map((r, idx) => {
      const parsed = parsedByIdx.get(idx);
      if (!parsed) return r;
      const events = extractDeficitEvents(parsed.values, parsed.dates, r.demand, { minDuration });
      return { ...r, events, summary: summariseEvents(events) };
    }));
  }, [minDuration, parsedByIdx]);

  // Flatten to (nodeName, event) pairs for the events table. Sorted by
  // duration descending — longest droughts first, which is the question
  // operators ask first.
  const flatEvents = useMemo(() => {
    const out: { row: DcRow; event: DeficitEvent }[] = [];
    for (const r of rows) {
      if (!r.events) continue;
      for (const e of r.events) out.push({ row: r, event: e });
    }
    out.sort((a, b) => b.event.duration - a.event.duration);
    return out;
  }, [rows]);

  // DC summary: count events per row, then sort by event count desc so the
  // most-event-prone DCs surface first.
  const dcSummaries = useMemo(() => {
    return rows
      .filter((r) => r.summary && r.summary.count > 0)
      .sort((a, b) => (b.summary!.count - a.summary!.count));
  }, [rows]);

  if (candidates.length === 0) {
    return (
      <div style={emptyStyle}>
        No Output nodes with a numeric <code>max_flow</code> demand and a
        node-bound recorder were found. The events log needs both. Add a
        <code> max_flow</code> + <code>NumpyArrayNodeRecorder</code>, then
        re-run the model.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div style={headerStyle}>
        <div style={titleStyle}>Deficit events</div>
        <div style={subtitleStyle}>
          {flatEvents.length} event{flatEvents.length === 1 ? "" : "s"} across{" "}
          {dcSummaries.length} demand centre{dcSummaries.length === 1 ? "" : "s"}
          {loading && ` · loaded ${loadedCount}/${candidates.length}`}
        </div>
        <label style={controlRowStyle}>
          <span style={controlLabelStyle}>Min duration</span>
          <input
            type="number"
            min={1}
            max={365}
            step={1}
            value={minDuration}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1) setMinDuration(n);
            }}
            style={controlInputStyle}
            aria-label="Minimum event duration in days"
          />
          <span style={controlSuffixStyle}>days</span>
        </label>
      </div>

      <div style={bodyStyle}>
        {dcSummaries.length > 0 && (
          <div style={{ marginBottom: 18 }}>
            <div style={sectionTitleStyle}>Per-demand-centre summary</div>
            <DcSummaryStrip rows={dcSummaries} onSelect={onSelectNode} />
          </div>
        )}

        <div style={sectionTitleStyle}>
          Events (sorted by duration)
        </div>
        {flatEvents.length === 0 ? (
          <div style={cleanBodyStyle}>
            No deficit runs of at least {minDuration} days were detected. Lower
            the minimum-duration threshold to see shorter events.
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Demand centre</th>
                <th style={thStyle}>Start</th>
                <th style={thStyle}>End</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Duration</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Total shortfall</th>
                <th style={{ ...thStyle, textAlign: "right" }}>Peak</th>
              </tr>
            </thead>
            <tbody>
              {flatEvents.map((ev, i) => (
                <tr
                  key={`${ev.row.nodeName}-${ev.event.startIndex}-${i}`}
                  onClick={() => onSelectNode(ev.row.nodeName)}
                  style={trStyle}
                  title={`Click to inspect ${ev.row.nodeName}`}
                >
                  <td style={tdStyle}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
                      {ev.row.nodeName}
                    </div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>
                      demand {formatVolume(ev.row.demand)}
                    </div>
                  </td>
                  <td style={tdMonoStyle}>{ev.event.startDate}</td>
                  <td style={tdMonoStyle}>{ev.event.endDate}</td>
                  <td style={{ ...tdMonoStyle, fontWeight: 700, color: "#dc2626" }}>
                    {ev.event.duration} d
                  </td>
                  <td style={tdMonoStyle}>{formatVolume(ev.event.totalShortfall)}</td>
                  <td style={tdMonoStyle}>{formatVolume(ev.event.peakShortfall)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// Per-DC summary strip — count + bar showing max duration relative to the
// longest event in the whole table. Inline SVG bars; no plotting lib.
function DcSummaryStrip({
  rows, onSelect,
}: { rows: DcRow[]; onSelect: (name: string) => void }) {
  const maxBar = Math.max(1, ...rows.map((r) => r.summary?.maxDuration ?? 0));
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {rows.map((r) => {
        const s = r.summary!;
        const pct = (s.maxDuration / maxBar) * 100;
        return (
          <div
            key={r.nodeName}
            onClick={() => onSelect(r.nodeName)}
            style={dcRowStyle}
            title={`${s.count} events · max ${s.maxDuration} d · mean ${s.meanDuration.toFixed(1)} d`}
          >
            <div style={dcNameStyle}>{r.nodeName}</div>
            <div style={dcBarTrackStyle}>
              <div style={{ ...dcBarFillStyle, width: `${pct}%` }} />
            </div>
            <div style={dcStatStyle}>
              <span>{s.count}×</span>
              <span style={{ marginLeft: 8 }}>max {s.maxDuration}d</span>
              <span style={{ marginLeft: 8 }}>µ {s.meanDuration.toFixed(1)}d</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function updateRow(prev: DcRow[], idx: number, patch: Partial<DcRow>): DcRow[] {
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
  fontSize: 14, fontWeight: 700, color: "#0f172a",
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11, color: "#64748b",
};

const controlRowStyle: React.CSSProperties = {
  display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#475569",
};

const controlLabelStyle: React.CSSProperties = {
  fontWeight: 600,
};

const controlInputStyle: React.CSSProperties = {
  padding: "4px 8px", fontSize: 12, width: 64,
  border: "1px solid #e2e8f0", borderRadius: 4,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const controlSuffixStyle: React.CSSProperties = {
  color: "#94a3b8",
};

const bodyStyle: React.CSSProperties = {
  flex: 1, overflow: "auto", padding: 16, background: "#f8fafc",
};

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, color: "#475569",
  textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6,
};

const cleanBodyStyle: React.CSSProperties = {
  padding: 14, background: "#ecfdf5",
  border: "1px solid #bbf7d0", borderRadius: 6,
  color: "#065f46", fontSize: 12,
};

const tableStyle: React.CSSProperties = {
  width: "100%", borderCollapse: "collapse",
  background: "#fff", border: "1px solid #e2e8f0",
  borderRadius: 6, overflow: "hidden",
};

const thStyle: React.CSSProperties = {
  background: "#f1f5f9", borderBottom: "1px solid #e2e8f0",
  fontSize: 10, fontWeight: 700, color: "#64748b",
  textTransform: "uppercase", letterSpacing: 0.5,
  padding: "8px 12px", textAlign: "left",
};

const trStyle: React.CSSProperties = {
  cursor: "pointer", borderBottom: "1px solid #f1f5f9",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px", fontSize: 12, verticalAlign: "top", color: "#0f172a",
};

const tdMonoStyle: React.CSSProperties = {
  ...tdStyle, textAlign: "right",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
};

const dcRowStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 220px",
  gap: 12,
  alignItems: "center",
  padding: "6px 10px",
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 12,
};

const dcNameStyle: React.CSSProperties = {
  fontWeight: 600, color: "#0f172a",
  whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis",
};

const dcBarTrackStyle: React.CSSProperties = {
  height: 8,
  background: "#fef2f2",
  borderRadius: 4,
  overflow: "hidden",
};

const dcBarFillStyle: React.CSSProperties = {
  height: "100%",
  background: "linear-gradient(90deg, #f97316, #dc2626)",
};

const dcStatStyle: React.CSSProperties = {
  color: "#475569",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  textAlign: "right",
};

const emptyStyle: React.CSSProperties = {
  flex: 1, display: "flex", alignItems: "center", justifyContent: "center",
  color: "#64748b", fontSize: 13, padding: 24, textAlign: "center",
};

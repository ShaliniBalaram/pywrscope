// src/components/SourceAttribution.tsx
// T3.10 — node-pair source attribution.
//
// For a selected downstream node (typically an Output, but valid for any
// non-source node with recorded flow), decompose its recorded inflow into
// fractional shares from each upstream source. The view is the inverse
// question of the existing downstream BFS / active-flow edge highlight:
//
//   - Existing: "Where does flow from THIS source end up?"
//   - This view: "Where did flow at THIS sink originate?"
//
// Renders:
//   1. Header card with sink name, recorded flow, and unresolved-share callout.
//   2. Stacked horizontal bar showing every contributing source as a coloured
//      segment (sized by fraction) — gives a one-glance picture of mix.
//   3. Sortable table with per-source fraction, contribution, and recorded-flow
//      context.
//
// Math lives in `lib/sourceAttribution.ts`; this file owns layout, colour
// rotation, and the click-through to the per-node Downstream view.

import React, { useMemo } from "react";
import type { PywrModel } from "../types/pywr";
import type { RunResultsView } from "../hooks/useRunResults";
import { normalizeNodeType } from "../constants/nodeTypes";
import {
  computeSourceAttribution,
  formatFraction,
  type AttributedSource,
  type SourceAttribution as SourceAttributionResult,
  type SourceRole,
} from "../lib/sourceAttribution";
import { formatVolume } from "../lib/massBalance";

// Colour rotation for the stacked bar + table dots. Picked from the canvas's
// existing palette so the same colour means "the same source" if the user
// switches between Downstream and Sources views.
const SEGMENT_COLORS = [
  "#1d4ed8", // blue
  "#059669", // emerald
  "#b45309", // amber
  "#7c3aed", // violet
  "#db2777", // pink
  "#0e7490", // cyan
  "#dc2626", // red
  "#d97706", // orange
];

const ROLE_LABEL: Record<SourceRole, string> = {
  input: "Input",
  catchment: "Catchment",
  discharge: "Discharge",
  other: "Source",
};

interface SourceAttributionProps {
  model: PywrModel;
  runResults: RunResultsView;
  selectedNodeName: string | null;
  onSelectNode: (name: string) => void;
}

export function SourceAttribution({
  model,
  runResults,
  selectedNodeName,
  onSelectNode,
}: SourceAttributionProps) {
  // Result is null until both (a) a node is selected and (b) the runResults
  // have populated. We don't gate on selectedNodeName earlier because the
  // empty-state hint changes depending on which precondition is missing —
  // showing "select a node" while we wait for runResults would be wrong.
  const result = useMemo<SourceAttributionResult | null>(() => {
    if (!selectedNodeName) return null;
    if (runResults.nodeFlow.size === 0) return null;
    return computeSourceAttribution(model, runResults.nodeFlow, selectedNodeName);
  }, [model, runResults.nodeFlow, selectedNodeName]);

  if (!selectedNodeName) {
    return (
      <div style={emptyStyle}>
        Pick a sink on the left to see which upstream sources contributed to
        its recorded flow. Works best for Output-type demand nodes, but any
        node with recorded inflow can be analysed.
      </div>
    );
  }

  if (runResults.nodeFlow.size === 0) {
    return (
      <div style={emptyStyle}>
        Source attribution needs aggregate flow data from a completed run. Run
        the model, then come back here.
      </div>
    );
  }

  if (!result) return null;

  if (result.error) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Header result={result} model={model} />
        <div style={errorBoxStyle}>{result.error}</div>
      </div>
    );
  }

  if (result.sources.length === 0) {
    return (
      <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Header result={result} model={model} />
        <div style={emptyStateStyle}>
          No upstream sources with recorded flow were found. Either the sink
          is itself a source, or every upstream branch carried zero flow this
          run.
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Header result={result} model={model} />
      <div style={bodyStyle}>
        {result.cycleDetected && (
          <div style={warningBoxStyle}>
            A cycle was detected in the flow path. Attribution may be
            approximate — some claim was trapped inside the cycle and rolled
            into the unresolved share.
          </div>
        )}
        {result.unresolved > 0.001 && (
          <div style={infoBoxStyle}>
            {formatFraction(result.unresolved)} of the sink's inflow couldn't
            be attributed to a recorded source. This usually means an upstream
            branch carries flow without a node recorder, or a branch went
            unrecorded this run.
          </div>
        )}
        <StackedBar sources={result.sources} unresolved={result.unresolved} />
        <SourceTable
          sources={result.sources}
          unresolved={result.unresolved}
          onSelectNode={onSelectNode}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header — sink name, type, recorded flow
// ---------------------------------------------------------------------------

function Header({
  result,
  model,
}: {
  result: SourceAttributionResult;
  model: PywrModel;
}) {
  // Pull node type so we can show "(Output)" next to the name. The model
  // already validated the sink exists when computeSourceAttribution ran.
  const nodeType = useMemo(() => {
    const n = model.nodes.find((nn) => nn.name === result.sinkName);
    return n?.type ?? "";
  }, [model, result.sinkName]);

  return (
    <div style={headerStyle}>
      <div style={titleStyle}>
        Source attribution — <span style={{ color: "#1d4ed8" }}>{result.sinkName}</span>
      </div>
      <div style={subtitleStyle}>
        {nodeType && <>{normalizeNodeType(nodeType)} · </>}
        recorded flow = {formatVolume(result.sinkFlow)} ·{" "}
        {result.sources.length} contributing source{result.sources.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stacked bar — one segment per source plus an "unresolved" tail
// ---------------------------------------------------------------------------

function StackedBar({
  sources,
  unresolved,
}: {
  sources: AttributedSource[];
  unresolved: number;
}) {
  // Segments are pre-sorted descending by fraction (the lib does this). Tiny
  // segments (< 1%) collapse into a single "other" pill at the tail so the
  // bar stays readable on networks with many small contributors.
  const SMALL_THRESHOLD = 0.01;
  const visible: AttributedSource[] = [];
  let otherFraction = 0;
  for (const s of sources) {
    if (s.fraction >= SMALL_THRESHOLD) visible.push(s);
    else otherFraction += s.fraction;
  }

  return (
    <div style={barCardStyle}>
      <div style={barCaptionStyle}>
        <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>
          Inflow composition
        </div>
        <div style={{ fontSize: 10, color: "#64748b" }}>
          Hover a segment for details
        </div>
      </div>
      <div style={barTrackStyle}>
        {visible.map((s, i) => (
          <div
            key={s.name}
            title={`${s.name} (${ROLE_LABEL[s.role]}) — ${formatFraction(s.fraction)} of inflow · ${formatVolume(s.contribution)}`}
            style={{
              width: `${s.fraction * 100}%`,
              background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
              borderRight: i < visible.length - 1 ? "1px solid #fff" : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: "#fff",
              fontWeight: 600,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              overflow: "hidden",
              whiteSpace: "nowrap",
              textOverflow: "ellipsis",
              padding: "0 4px",
              minWidth: 0,
            }}
          >
            {s.fraction >= 0.05 && formatFraction(s.fraction)}
          </div>
        ))}
        {otherFraction > 0 && (
          <div
            title={`${sources.length - visible.length} smaller source${sources.length - visible.length === 1 ? "" : "s"} — ${formatFraction(otherFraction)} combined`}
            style={{
              width: `${otherFraction * 100}%`,
              background: "#94a3b8",
              borderLeft: visible.length > 0 ? "1px solid #fff" : "none",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: "#fff",
              fontWeight: 600,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {otherFraction >= 0.05 && `+${formatFraction(otherFraction)}`}
          </div>
        )}
        {unresolved > 0.001 && (
          <div
            title={`${formatFraction(unresolved)} unresolved — no recorder on the upstream branch`}
            style={{
              width: `${unresolved * 100}%`,
              background: "repeating-linear-gradient(45deg, #cbd5e1, #cbd5e1 4px, #e2e8f0 4px, #e2e8f0 8px)",
              borderLeft: "1px solid #fff",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: 10,
              color: "#475569",
              fontWeight: 600,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            }}
          >
            {unresolved >= 0.05 && "unresolved"}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Table — per-source rows
// ---------------------------------------------------------------------------

function SourceTable({
  sources,
  unresolved,
  onSelectNode,
}: {
  sources: AttributedSource[];
  unresolved: number;
  onSelectNode: (name: string) => void;
}) {
  return (
    <div style={tableCardStyle}>
      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={{ ...thStyle, width: 18 }}></th>
            <th style={thStyle}>Source</th>
            <th style={thStyle}>Role</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Share</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Contribution</th>
            <th style={{ ...thStyle, textAlign: "right" }}>Source flow</th>
          </tr>
        </thead>
        <tbody>
          {sources.map((s, i) => (
            <tr
              key={s.name}
              onClick={() => onSelectNode(s.name)}
              style={trStyle}
              title={`Click to inspect ${s.name} in the Downstream panel`}
            >
              <td style={tdStyle}>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background: SEGMENT_COLORS[i % SEGMENT_COLORS.length],
                  }}
                />
              </td>
              <td style={tdStyle}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#0f172a" }}>{s.name}</div>
                <div style={{ fontSize: 10, color: "#64748b" }}>{s.nodeType}</div>
              </td>
              <td style={{ ...tdStyle, fontSize: 11, color: "#475569" }}>
                {ROLE_LABEL[s.role]}
              </td>
              <td style={{ ...tdMonoStyle, fontWeight: 600 }}>
                {formatFraction(s.fraction)}
              </td>
              <td style={tdMonoStyle}>{formatVolume(s.contribution)}</td>
              <td style={tdMonoStyle}>{formatVolume(s.recordedFlow)}</td>
            </tr>
          ))}
          {unresolved > 0.001 && (
            <tr style={{ ...trStyle, cursor: "default" }}>
              <td style={tdStyle}>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    borderRadius: 2,
                    background:
                      "repeating-linear-gradient(45deg, #cbd5e1, #cbd5e1 3px, #e2e8f0 3px, #e2e8f0 6px)",
                  }}
                />
              </td>
              <td style={tdStyle}>
                <div style={{ fontSize: 12, fontWeight: 600, color: "#475569" }}>
                  unresolved
                </div>
                <div style={{ fontSize: 10, color: "#94a3b8" }}>no upstream recorder</div>
              </td>
              <td style={{ ...tdStyle, fontSize: 11, color: "#475569" }}>—</td>
              <td style={{ ...tdMonoStyle, color: "#64748b" }}>{formatFraction(unresolved)}</td>
              <td style={{ ...tdMonoStyle, color: "#64748b" }}>—</td>
              <td style={{ ...tdMonoStyle, color: "#64748b" }}>—</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

const headerStyle: React.CSSProperties = {
  padding: "12px 16px",
  borderBottom: "1px solid #e2e8f0",
  background: "#fff",
  flexShrink: 0,
};

const titleStyle: React.CSSProperties = {
  fontSize: 14,
  fontWeight: 700,
  color: "#0f172a",
  marginBottom: 4,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 11,
  color: "#64748b",
};

const bodyStyle: React.CSSProperties = {
  flex: 1,
  overflow: "auto",
  padding: 16,
  background: "#f8fafc",
};

const barCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
  marginBottom: 12,
};

const barCaptionStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  padding: "6px 12px",
  borderBottom: "1px solid #e2e8f0",
  background: "#f8fafc",
};

const barTrackStyle: React.CSSProperties = {
  display: "flex",
  width: "100%",
  height: 32,
  background: "#f1f5f9",
};

const tableCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "hidden",
};

const tableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
};

const thStyle: React.CSSProperties = {
  background: "#f1f5f9",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 10,
  fontWeight: 700,
  color: "#64748b",
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "8px 12px",
  textAlign: "left",
};

const trStyle: React.CSSProperties = {
  cursor: "pointer",
  borderBottom: "1px solid #f1f5f9",
};

const tdStyle: React.CSSProperties = {
  padding: "8px 12px",
  verticalAlign: "top",
  fontSize: 12,
};

const tdMonoStyle: React.CSSProperties = {
  ...tdStyle,
  textAlign: "right",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  color: "#0f172a",
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

const emptyStateStyle: React.CSSProperties = {
  margin: 16,
  padding: 18,
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  color: "#64748b",
  fontSize: 12,
  textAlign: "center",
};

const errorBoxStyle: React.CSSProperties = {
  margin: 16,
  padding: 14,
  background: "#fef2f2",
  border: "1px solid #fecaca",
  borderRadius: 6,
  color: "#991b1b",
  fontSize: 12,
};

const warningBoxStyle: React.CSSProperties = {
  padding: 12,
  background: "#fffbeb",
  border: "1px solid #fde68a",
  borderRadius: 6,
  color: "#92400e",
  fontSize: 12,
  marginBottom: 12,
};

const infoBoxStyle: React.CSSProperties = {
  padding: 12,
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  borderRadius: 6,
  color: "#1e40af",
  fontSize: 12,
  marginBottom: 12,
};

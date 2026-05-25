// src/components/SankeyView.tsx
// T2.5 — annual network Sankey.
//
// Reads `edge_flows.json` (written by run_pywr.py when the solver supports
// `save_routes_flows`), runs the pure layout pipeline in src/lib/sankeyLayout,
// then renders the result as inline SVG. No external chart library — the
// math fits in one file and we keep the bundle lean.
//
// Visual contract:
//   - Source nodes (no incoming edges) sit at the left, sinks at the right.
//   - Each node is a vertical bar whose height ∝ throughput
//     (max of total inflow or total outflow).
//   - Each edge is a Bézier ribbon whose width ∝ flow.
//   - Hovering an edge shows the source/target names and the volumes
//     (total + annualised when timesteps were captured).
//   - Clicking a node label jumps to the per-node Downstream view, same as
//     the other Results-tab sub-views.
//
// Graceful empty states:
//   - No run yet: the toggle is disabled at the ResultsTab level.
//   - Run exists but no edge_flows.json: the solver didn't capture routes.
//     We surface a hint explaining the prerequisite rather than a blank pane.
//   - edge_flows.json parsed but has zero edges: usually means the run had
//     no LP routes (degenerate model). Hint says so.

import React, { useEffect, useMemo, useState } from "react";
import type { RunStateView } from "../hooks/useModelRun";
import {
  computeSankeyLayout,
  formatSankeyFlow,
  type SankeyData,
  type SankeyLayoutResult,
} from "../lib/sankeyLayout";

// Layer-coloured palette. Source-side leans cool, sink-side leans warm — gives
// a one-glance "this is the direction of flow" cue without needing labels.
const NODE_COLORS = [
  "#1d4ed8",
  "#0e7490",
  "#059669",
  "#65a30d",
  "#b45309",
  "#dc2626",
  "#9d174d",
  "#7c3aed",
];

interface SankeyViewProps {
  runState: RunStateView;
  onSelectNode: (name: string) => void;
}

interface LoadState {
  data: SankeyData | null;
  loading: boolean;
  error: string | null;
}

const INITIAL: LoadState = { data: null, loading: false, error: null };

export function SankeyView({ runState, onSelectNode }: SankeyViewProps) {
  const [state, setState] = useState<LoadState>(INITIAL);

  // Pull the edge_flows path out of the run's outputs index. The Python side
  // emits this entry only when the solver accepted save_routes_flows AND the
  // route-aggregation succeeded.
  const edgeFlowsPath = useMemo(() => {
    const ref = runState.outputs.find((o) => o.name === "edge_flows");
    return ref?.path ?? null;
  }, [runState.outputs]);

  useEffect(() => {
    if (!edgeFlowsPath) {
      setState(INITIAL);
      return;
    }
    let cancelled = false;
    setState({ data: null, loading: true, error: null });
    (async () => {
      try {
        const content = await window.pywr.readLayoutFile(edgeFlowsPath);
        if (cancelled) return;
        if (!content) {
          setState({ data: null, loading: false, error: "edge_flows.json is empty" });
          return;
        }
        const parsed = JSON.parse(content) as SankeyData;
        if (!parsed || !Array.isArray(parsed.edges)) {
          setState({
            data: null,
            loading: false,
            error: "edge_flows.json has no 'edges' array",
          });
          return;
        }
        setState({ data: parsed, loading: false, error: null });
      } catch (e) {
        if (cancelled) return;
        setState({
          data: null,
          loading: false,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [edgeFlowsPath]);

  const layout = useMemo<SankeyLayoutResult | null>(() => {
    if (!state.data) return null;
    return computeSankeyLayout(state.data);
  }, [state.data]);

  if (!edgeFlowsPath) {
    return (
      <div style={emptyStyle}>
        <strong>Sankey unavailable.</strong>
        <p style={{ margin: "8px 0 0 0", fontSize: 12 }}>
          The Sankey needs per-edge flow data, which the runner writes only
          when the Pywr solver supports <code>save_routes_flows</code>. If
          this is your first run after upgrading the canvas, run the model
          again — the runner will try to enable it. If the Sankey still
          doesn't appear, your Pywr build's solver doesn't expose route
          flows and only the per-node recorders are available.
        </p>
      </div>
    );
  }

  if (state.loading) {
    return <div style={emptyStyle}>Loading edge flows…</div>;
  }

  if (state.error) {
    return (
      <div style={emptyStyle}>
        <strong>Could not read edge_flows.json.</strong>
        <p style={{ margin: "8px 0 0 0", fontSize: 12, color: "#991b1b" }}>{state.error}</p>
      </div>
    );
  }

  if (!layout || layout.nodes.length === 0) {
    return (
      <div style={emptyStyle}>
        Edge flows file is present but contains no positive-flow edges. The
        run may have been degenerate (no LP routes), or every route was
        deactivated by cost.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <Header data={state.data!} layout={layout} />
      <div style={bodyStyle}>
        <SankeyDiagram layout={layout} onSelectNode={onSelectNode} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function Header({
  data,
  layout,
}: {
  data: SankeyData;
  layout: SankeyLayoutResult;
}) {
  // Total volume = sum of source-node outflows (= sum of sink inflows). We
  // pick the source side here because a "source" is a node with no incoming
  // edge, which means its outflow is its own contribution to the system.
  const totalVolume = useMemo(() => {
    let v = 0;
    for (const n of layout.nodes) {
      if (n.inFlow === 0) v += n.outFlow;
    }
    return v;
  }, [layout.nodes]);

  return (
    <div style={headerStyle}>
      <div style={titleStyle}>Annual flow Sankey</div>
      <div style={subtitleStyle}>
        {layout.nodes.length} node{layout.nodes.length === 1 ? "" : "s"} ·{" "}
        {layout.edges.length} edge{layout.edges.length === 1 ? "" : "s"} ·{" "}
        {data.totalRoutes.toLocaleString()} LP route
        {data.totalRoutes === 1 ? "" : "s"} ·{" "}
        Σ source flow = {formatSankeyFlow(totalVolume)}
        {data.timesteps > 0 && (
          <> · {data.timesteps.toLocaleString()} timesteps captured</>
        )}
      </div>
      {layout.cycleDetected && (
        <div style={warnStyle}>
          A cycle was detected in the edge graph. Layer assignment is
          approximate — cyclic nodes were placed in the leftmost layer.
        </div>
      )}
      {layout.droppedNodes.length > 0 && (
        <div style={infoStyle}>
          {layout.droppedNodes.length} zero-throughput node
          {layout.droppedNodes.length === 1 ? "" : "s"} hidden from the
          diagram. (No flow recorded into or out of them.)
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Diagram
// ---------------------------------------------------------------------------

function SankeyDiagram({
  layout,
  onSelectNode,
}: {
  layout: SankeyLayoutResult;
  onSelectNode: (name: string) => void;
}) {
  const [hoverEdge, setHoverEdge] = useState<number | null>(null);
  const [hoverNode, setHoverNode] = useState<string | null>(null);
  const NODE_WIDTH = 14;
  const LABEL_PAD = 6;

  const layerMax = useMemo(
    () => layout.nodes.reduce((m, n) => Math.max(m, n.layer), 0),
    [layout.nodes],
  );

  return (
    <div style={diagramCardStyle}>
      <svg
        viewBox={`-160 -16 ${layout.width + 320} ${layout.height + 60}`}
        width="100%"
        height={layout.height + 60}
        style={{ display: "block", background: "#fff" }}
        role="img"
        aria-label="Annual network Sankey"
      >
        {/* Edges first so node bars sit on top. */}
        {layout.edges.map((e, i) => {
          const isHover = hoverEdge === i;
          const isFaded = hoverEdge !== null && !isHover;
          return (
            <path
              key={`${e.u}->${e.v}`}
              d={e.path}
              fill="none"
              stroke="#1d4ed8"
              strokeOpacity={isHover ? 0.85 : isFaded ? 0.05 : 0.32}
              strokeWidth={e.width}
              strokeLinecap="butt"
              style={{ cursor: "pointer" }}
              onMouseEnter={() => setHoverEdge(i)}
              onMouseLeave={() => setHoverEdge(null)}
            >
              <title>
                {e.u} → {e.v}: {formatSankeyFlow(e.total)}
                {e.annual !== null ? ` (${formatSankeyFlow(e.annual)} /yr)` : ""}
              </title>
            </path>
          );
        })}

        {/* Nodes */}
        {layout.nodes.map((n) => {
          const color = NODE_COLORS[n.layer % NODE_COLORS.length];
          const labelOnRight = n.layer < layerMax / 2;
          const labelX = labelOnRight ? n.x + NODE_WIDTH + LABEL_PAD : n.x - LABEL_PAD;
          const labelAnchor = labelOnRight ? "start" : "end";
          const isHover = hoverNode === n.name;
          return (
            <g key={n.name}>
              <rect
                x={n.x}
                y={n.y}
                width={NODE_WIDTH}
                height={n.height}
                fill={color}
                opacity={isHover ? 1 : 0.92}
                rx={2}
                onMouseEnter={() => setHoverNode(n.name)}
                onMouseLeave={() => setHoverNode(null)}
                onClick={() => onSelectNode(n.name)}
                style={{ cursor: "pointer" }}
              >
                <title>
                  {n.name}: in {formatSankeyFlow(n.inFlow)} · out {formatSankeyFlow(n.outFlow)}
                </title>
              </rect>
              <text
                x={labelX}
                y={n.y + n.height / 2 + 3}
                textAnchor={labelAnchor}
                fontSize={11}
                fill="#0f172a"
                fontWeight={isHover ? 700 : 500}
                style={{ cursor: "pointer" }}
                onClick={() => onSelectNode(n.name)}
              >
                {n.name}
              </text>
            </g>
          );
        })}

        {/* Edge readout — bottom of the SVG, repositioned each render to the
            hovered edge so the user always knows what their cursor is over. */}
        {hoverEdge !== null && layout.edges[hoverEdge] && (
          <g pointerEvents="none">
            <text
              x={layout.width / 2}
              y={layout.height + 36}
              textAnchor="middle"
              fontSize={12}
              fill="#0f172a"
              fontFamily="ui-monospace, SFMono-Regular, Menlo, monospace"
            >
              {layout.edges[hoverEdge].u} → {layout.edges[hoverEdge].v}:{" "}
              {formatSankeyFlow(layout.edges[hoverEdge].total)}
              {layout.edges[hoverEdge].annual !== null
                ? ` · ${formatSankeyFlow(layout.edges[hoverEdge].annual!)} /yr`
                : ""}
            </text>
          </g>
        )}
      </svg>
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

const diagramCardStyle: React.CSSProperties = {
  background: "#fff",
  border: "1px solid #e2e8f0",
  borderRadius: 6,
  overflow: "auto",
  padding: 8,
};

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: 13,
  padding: 24,
  textAlign: "center",
};

const warnStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "#92400e",
  background: "#fffbeb",
  border: "1px solid #fde68a",
  padding: "4px 8px",
  borderRadius: 4,
};

const infoStyle: React.CSSProperties = {
  marginTop: 6,
  fontSize: 11,
  color: "#1e40af",
  background: "#eff6ff",
  border: "1px solid #bfdbfe",
  padding: "4px 8px",
  borderRadius: 4,
};

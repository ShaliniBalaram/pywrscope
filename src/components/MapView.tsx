// src/components/MapView.tsx
// Map tab — third top-level view alongside Canvas and JSON.
//
// Purpose: open the prepared / loaded network on a map-style surface, let the
// user drag nodes freely with a live coordinate trace, and run the model on
// Pywr directly from this tab. Position changes here propagate up to the same
// layout state the Canvas tab uses, so the JSON tab stays in sync automatically
// (see the layout→model effect in App.tsx).

import React, { useCallback, useMemo, useRef, useState } from "react";
import ReactFlow, {
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Node as RFNode,
  Edge as RFEdge,
  NodeChange,
  applyNodeChanges,
} from "reactflow";
import "reactflow/dist/style.css";

import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import {
  NODE_COLOUR_MAP,
  NODE_SHAPE_MAP,
  normalizeNodeType,
} from "../constants/nodeTypes";

interface MapViewProps {
  model: PywrModel;
  positions: Record<string, { x: number; y: number }>;
  backgroundImage: string | null;
  backgroundOpacity: number;
  onNodeMove: (name: string, x: number, y: number) => void;
  // Run wiring — same useModelRun hook owned by App.tsx, threaded down so the
  // tab can show inline run controls without owning lifecycle.
  runState: RunStateView;
  runDisabledReason: string | null;
  onRun: () => void;
  onCancelRun: () => void;
  // Results viewer trigger — App.tsx owns the modal so it can also be reached
  // from elsewhere (e.g. the run-complete handoff). The button lives here so
  // a user staying on the Map tab can open results without leaving.
  onOpenResults: (initialPath?: string | null) => void;
  // Global selection — when set, this map renders the node with a yellow
  // border AND tells App which node drives the active-flow-edge highlight.
  selectedNodeName: string | null;
  onSelectNode: (name: string | null) => void;
  // Edges that lie on a path from the selected node to an active Output sink.
  // Comes from App's useRunResults / activeFlowEdges() computation; the map
  // paints these green so flow direction reads at a glance.
  activeFlowEdges: Set<string>;
}

export function MapView(props: MapViewProps) {
  return (
    <ReactFlowProvider>
      <MapViewInner {...props} />
    </ReactFlowProvider>
  );
}

function MapViewInner({
  model,
  positions,
  backgroundImage,
  backgroundOpacity,
  onNodeMove,
  runState,
  runDisabledReason,
  onRun,
  onCancelRun,
  onOpenResults,
  selectedNodeName,
  onSelectNode,
  activeFlowEdges,
}: MapViewProps) {
  // The map is now fully controlled by App's selection state so the canvas
  // and the map agree on what's selected and (therefore) what's highlighted.
  const selectedName = selectedNodeName;
  const setSelectedName = onSelectNode;

  // Build RF nodes/edges from the model. The map view uses simple coloured
  // circles so the focus stays on position and topology — no shape variants,
  // no labels-by-default, no editing affordances.
  const rfNodes: RFNode[] = useMemo(() => {
    return model.nodes.map((node) => {
      const canonical = normalizeNodeType(node.type);
      const colour = NODE_COLOUR_MAP[canonical] ?? "#888";
      const shape = NODE_SHAPE_MAP[canonical]?.shape ?? "rectangle";
      const pos = positions[node.name] ?? { x: 0, y: 0 };
      return {
        id: node.name,
        type: "default",
        position: pos,
        data: { label: node.name },
        draggable: true,
        selected: node.name === selectedName,
        style: {
          width: 64,
          height: 64,
          borderRadius: shape === "circle" ? "50%" : 8,
          backgroundColor: colour,
          color: "#fff",
          fontSize: 11,
          fontWeight: 600,
          border: node.name === selectedName ? "2px solid #facc15" : "2px solid rgba(0,0,0,0.35)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: 4,
          boxShadow: "0 2px 4px rgba(0,0,0,0.25)",
        },
      };
    });
  }, [model.nodes, positions, selectedName]);

  const rfEdges: RFEdge[] = useMemo(() => {
    return model.edges.map((e, i) => {
      const [from, to] = e;
      const isActive = activeFlowEdges.has(`${from}->${to}`);
      const stroke = isActive ? "#10b981" : "#475569";
      return {
        id: `${from}->${to}#${i}`,
        source: from,
        target: to,
        type: "default",
        // Animate active edges so flow direction reads at a glance — the
        // selected node lights up only the path(s) carrying recorded flow.
        animated: isActive,
        style: { stroke, strokeWidth: isActive ? 3 : 2 },
        markerEnd: { type: "arrowclosed", color: stroke } as unknown as RFEdge["markerEnd"],
      } as RFEdge;
    });
  }, [model.edges, activeFlowEdges]);

  // Drag handler — ReactFlow fires position changes during drag and on drag
  // stop. We forward only on drag stop so the layout history isn't spammed
  // mid-drag, but the local node array still needs to reflect mid-drag motion
  // so the user sees movement. RF handles the mid-drag visual via its own
  // internal state when we pass the nodes through applyNodeChanges.
  const [liveNodes, setLiveNodes] = useState<RFNode[]>(rfNodes);
  // Keep liveNodes in sync when the source positions change externally (e.g.
  // a model was just loaded, or another tab moved a node).
  const lastSyncKey = useRef<string>("");
  React.useEffect(() => {
    // Cheap structural signature — only re-syncs when names or positions change.
    const key = rfNodes.map((n) => `${n.id}:${n.position.x},${n.position.y}`).join("|");
    if (key !== lastSyncKey.current) {
      lastSyncKey.current = key;
      setLiveNodes(rfNodes);
    }
  }, [rfNodes]);

  const onNodesChange = useCallback(
    (changes: NodeChange[]) => {
      setLiveNodes((prev) => applyNodeChanges(changes, prev));
      for (const c of changes) {
        if (c.type === "position" && c.dragging === false && c.position) {
          // Drag finished — commit to layout state. App's layout→model effect
          // will then push the new coords into the JSON.
          onNodeMove(c.id, Math.round(c.position.x), Math.round(c.position.y));
        }
      }
    },
    [onNodeMove]
  );

  // Live coords for the side panel — read from liveNodes so the readout updates
  // smoothly during a drag, not just on release.
  const liveCoords: Record<string, { x: number; y: number }> = useMemo(() => {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of liveNodes) {
      out[n.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
    }
    return out;
  }, [liveNodes]);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", backgroundColor: "#f8fafc" }}>
      {/* Map surface */}
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        {backgroundImage && (
          // Background image behind the flow — opacity comes from the same
          // layout setting the Canvas tab uses, so users see one consistent map.
          <img
            src={backgroundImage}
            alt=""
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
              objectFit: "contain",
              opacity: backgroundOpacity,
              pointerEvents: "none",
              zIndex: 0,
            }}
          />
        )}
        <ReactFlow
          nodes={liveNodes}
          edges={rfEdges}
          onNodesChange={onNodesChange}
          onNodeClick={(_, n) => setSelectedName(n.id)}
          onPaneClick={() => setSelectedName(null)}
          nodesDraggable
          nodesConnectable={false}
          elementsSelectable
          fitView
          fitViewOptions={{ padding: 0.2 }}
          minZoom={0.05}
          maxZoom={4}
          style={{ backgroundColor: "transparent" }}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#cbd5e1" />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable nodeColor={(n) => (n.style?.backgroundColor as string) ?? "#888"} />
        </ReactFlow>
      </div>

      {/* Side panel — run controls + live coordinate trace */}
      <div
        style={{
          width: 300,
          flexShrink: 0,
          backgroundColor: "#0f172a",
          color: "#e2e8f0",
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid #1e293b",
        }}
      >
        <RunSection
          runState={runState}
          runDisabledReason={runDisabledReason}
          onRun={onRun}
          onCancelRun={onCancelRun}
          onOpenResults={onOpenResults}
        />
        <CoordsPanel
          coords={liveCoords}
          selectedName={selectedName}
          onSelect={setSelectedName}
        />
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Run section — inline Run / Cancel + progress, mirrors RunPanel semantics but
// lives in the side panel so users don't need to glance back at the toolbar.
// -----------------------------------------------------------------------------
function RunSection({
  runState,
  runDisabledReason,
  onRun,
  onCancelRun,
  onOpenResults,
}: {
  runState: RunStateView;
  runDisabledReason: string | null;
  onRun: () => void;
  onCancelRun: () => void;
  onOpenResults: (initialPath?: string | null) => void;
}) {
  const active = runState.status === "running" || runState.status === "starting";
  const disabled = runDisabledReason !== null;
  // When the most recent run finished successfully, surface the first non-
  // summary CSV as a one-click entry point into the viewer. The user can also
  // pick any other file via the generic "Open results" button below.
  const firstResultPath = runState.status === "done"
    ? (runState.outputs.find((o) => !o.name.toLowerCase().includes("summary"))
       ?? runState.outputs[0])?.path ?? null
    : null;
  return (
    <div style={{ padding: 14, borderBottom: "1px solid #1e293b" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        Pywr Run
      </div>
      {!active && (
        <button
          onClick={onRun}
          disabled={disabled}
          title={runDisabledReason ?? "Run this model on Pywr"}
          style={{
            width: "100%",
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 6,
            border: "none",
            cursor: disabled ? "not-allowed" : "pointer",
            backgroundColor: disabled ? "#334155" : "#1d4ed8",
            color: disabled ? "#64748b" : "#fff",
          }}
        >
          ▶ Run on Pywr
        </button>
      )}
      {active && (
        <button
          onClick={onCancelRun}
          style={{
            width: "100%",
            padding: "8px 12px",
            fontSize: 13,
            fontWeight: 600,
            borderRadius: 6,
            border: "none",
            cursor: "pointer",
            backgroundColor: "#dc2626",
            color: "#fff",
          }}
        >
          ■ Cancel
        </button>
      )}
      {disabled && !active && (
        <div style={{ fontSize: 11, color: "#fbbf24", marginTop: 6 }}>{runDisabledReason}</div>
      )}
      {(active || runState.status === "done") && (
        <div style={{ marginTop: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#94a3b8", marginBottom: 4 }}>
            <span>{runState.step.toLocaleString()} / {runState.total.toLocaleString()}</span>
            <span>{runState.date || "—"}</span>
          </div>
          <div style={{ height: 6, backgroundColor: "#1e293b", borderRadius: 3, overflow: "hidden" }}>
            <div
              style={{
                width: `${runState.pct}%`,
                height: "100%",
                backgroundColor: runState.status === "done" ? "#10b981" : "#3B8BD4",
                transition: "width 0.2s ease",
              }}
            />
          </div>
          <div style={{ fontSize: 10, color: "#94a3b8", marginTop: 4 }}>
            {runState.pct}%{runState.stats ? ` · ${runState.stats.seconds.toFixed(2)}s` : ""}
          </div>
        </div>
      )}
      {runState.status === "error" && runState.error && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#fca5a5" }}>
          <div style={{ fontWeight: 600, marginBottom: 2 }}>{runState.error.code}</div>
          <div style={{ wordBreak: "break-word" }}>{runState.error.message}</div>
        </div>
      )}
      {runState.status === "done" && runState.outputs.length > 0 && (
        <div style={{ marginTop: 10, fontSize: 11, color: "#94a3b8" }}>
          {runState.outputs.length} output file(s) written.
        </div>
      )}

      {/* Results viewer entry points. Always available so users can open
          previously-saved CSV or HDF5 files even when no run is in flight. */}
      <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 6 }}>
        {firstResultPath && (
          <button
            onClick={() => onOpenResults(firstResultPath)}
            title={`Open ${firstResultPath}`}
            style={{
              padding: "6px 10px",
              fontSize: 12,
              fontWeight: 600,
              borderRadius: 6,
              border: "none",
              cursor: "pointer",
              backgroundColor: "#10b981",
              color: "#0f172a",
            }}
          >
            📊 View latest result
          </button>
        )}
        <button
          onClick={() => onOpenResults(null)}
          title="Open any .csv, .h5, or .hdf5 result file"
          style={{
            padding: "6px 10px",
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 6,
            border: "1px solid #334155",
            cursor: "pointer",
            backgroundColor: "transparent",
            color: "#e2e8f0",
          }}
        >
          📂 Open results file…
        </button>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Coordinate trace — live readout of every node's current (x, y) on the map.
// Clicking a row selects the node on the canvas. The list updates while the
// user drags so the trace truly mirrors the schematic position.
// -----------------------------------------------------------------------------
function CoordsPanel({
  coords,
  selectedName,
  onSelect,
}: {
  coords: Record<string, { x: number; y: number }>;
  selectedName: string | null;
  onSelect: (name: string) => void;
}) {
  const entries = Object.entries(coords).sort(([a], [b]) => a.localeCompare(b));
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ padding: "10px 14px 6px 14px", fontSize: 11, color: "#94a3b8", textTransform: "uppercase", letterSpacing: 0.5 }}>
        Schematic positions ({entries.length})
      </div>
      <div style={{ padding: "0 14px 6px 14px", fontSize: 10, color: "#64748b" }}>
        Drag a node on the map — coordinates update live and are written to the JSON on release.
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "4px 0" }}>
        {entries.map(([name, p]) => {
          const isSel = name === selectedName;
          return (
            <button
              key={name}
              onClick={() => onSelect(name)}
              style={{
                display: "grid",
                gridTemplateColumns: "1fr auto",
                gap: 8,
                width: "100%",
                textAlign: "left",
                padding: "5px 14px",
                background: isSel ? "#1e3a5f" : "transparent",
                border: "none",
                color: "#e2e8f0",
                cursor: "pointer",
                fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                fontSize: 11,
                borderLeft: isSel ? "2px solid #facc15" : "2px solid transparent",
              }}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
              <span style={{ color: "#94a3b8" }}>{p.x}, {p.y}</span>
            </button>
          );
        })}
        {entries.length === 0 && (
          <div style={{ padding: "12px 14px", fontSize: 11, color: "#64748b" }}>
            No nodes yet. Add nodes on the Canvas tab, then return here.
          </div>
        )}
      </div>
    </div>
  );
}

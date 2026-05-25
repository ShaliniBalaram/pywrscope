// src/components/Canvas.tsx
// React Flow canvas — renders Pywr nodes as draggable RF nodes, edges as RF edges.
// Background image rendered using useViewport so it pans and zooms with the canvas.
// Drag-and-drop from NodePalette creates nodes at the drop position.

import React, { useCallback, useEffect, useRef, useMemo, useState, useImperativeHandle } from "react";
import ReactFlow, {
  ReactFlowProvider,
  useReactFlow,
  useViewport,
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Node as RFNode,
  Edge as RFEdge,
  NodeTypes,
  EdgeTypes,
  Connection,
  ConnectionLineType,
} from "reactflow";
import "reactflow/dist/style.css";
import "../canvas.css";

import { PywrModel, PywrNode } from "../types/pywr";
import {
  NODE_COLOUR_MAP,
  NODE_SHAPE_MAP,
  normalizeNodeType,
} from "../constants/nodeTypes";
import { PywrNodeComponent } from "./PywrNode";
import { PywrEdge } from "./PywrEdge";
import { ContextMenu, ContextMenuItem } from "./ContextMenu";

export interface SelectedEdge {
  from: string;
  to: string;
}

export type TraceMode = "both" | "upstream" | "downstream" | "active";

export interface TraceSummary {
  selectedName: string;
  nodeType: string;
  inboundCount: number;
  outboundCount: number;
  upstreamCount: number;
  downstreamCount: number;
  tracedEdgeCount: number;
  activeEdgeCount: number;
}

const nodeTypes: NodeTypes = { pywr: PywrNodeComponent };
const edgeTypes: EdgeTypes = { pywr: PywrEdge };

// Shared empty fallback for the activeFlowEdges prop. Defined at module scope
// so React.memo on rfEdges doesn't bust every render when the prop is omitted.
const EMPTY_EDGE_SET: Set<string> = new Set();
const EMPTY_NODE_ROLE_MAP: Map<string, "upstream" | "downstream" | "both"> = new Map();

export interface CanvasHandle {
  zoomToNodes: (ids: string[]) => void;
  exportPng: () => Promise<void>;
}

interface CanvasProps {
  model: PywrModel | null;
  positions: Record<string, { x: number; y: number }>;
  backgroundImage: string | null;
  backgroundOpacity: number;
  selectedNodeNames: string[];
  selectedEdge: SelectedEdge | null;
  editingNodeName: string | null;
  highlightedNodeName: string | null;
  showLabels: boolean;
  gridSize: number;
  gridSnap: boolean;
  placementMode: boolean;
  edgeMode: boolean;
  edgeSource: string | null;
  traceMode: TraceMode;
  traceSummary: TraceSummary | null;
  onNodeSelect: (name: string | null, addToSelection?: boolean) => void;
  onEdgeSelect: (edge: SelectedEdge | null) => void;
  onTraceModeChange: (mode: TraceMode) => void;
  onNodeMove: (name: string, x: number, y: number) => void;
  onDeleteRequest: (name: string) => void;
  onDeleteMultiple: (names: string[]) => void;
  onDeleteEdgeRequest: (from: string, to: string) => void;
  onRenameRequest: (name: string) => void;
  onRenameComplete: (oldName: string, newName: string) => void;
  onAddNode: (nodeType: string, x: number, y: number) => void;
  onConnect: (from: string, to: string) => void;
  onPlacementClick: (flowX: number, flowY: number, screenX: number, screenY: number) => void;
  // Edges that carry active flow downstream of the currently-selected node,
  // as computed from the last run's recorders. Each entry is "from->to". The
  // canvas paints these edges green and slightly thicker. Empty set = no
  // highlighting (no run yet, no selection, or no active downstream flow).
  activeFlowEdges?: Set<string>;
  // Pure topology trace from the selected node. Unlike activeFlowEdges, this
  // works without run results: all reachable upstream/downstream edges render
  // with a presentation highlight so clients can follow the network.
  tracedTopologyEdges?: Set<string>;
  tracedNodeRoles?: Map<string, "upstream" | "downstream" | "both">;
}

// Convert PywrModel to React Flow nodes
function toRFNodes(
  model: PywrModel,
  positions: Record<string, { x: number; y: number }>,
  selectedNodeNames: string[],
  highlightedNodeName: string | null,
  tracedNodeRoles: Map<string, "upstream" | "downstream" | "both">,
  editingNodeName: string | null,
  showLabels: boolean,
  onRenameComplete: (oldName: string, newName: string) => void
): RFNode[] {
  return model.nodes.map((node: PywrNode) => {
    const canonicalType = normalizeNodeType(node.type);
    const name = node.name;
    return {
      id: name,
      type: "pywr",
      position: positions[name] ?? { x: 0, y: 0 },
      data: {
        label: name,
        nodeType: canonicalType,
        colour: NODE_COLOUR_MAP[canonicalType] ?? "#888",
        shape: NODE_SHAPE_MAP[canonicalType] ?? { shape: "rectangle", border: "solid" },
        highlighted: name === highlightedNodeName,
        traceRole: tracedNodeRoles.get(name),
        isEditing: name === editingNodeName,
        showLabels,
        onRenameComplete: (newName: string) => onRenameComplete(name, newName),
      },
      selected: selectedNodeNames.includes(name),
    };
  });
}

// Convert PywrModel edges to React Flow edges. activeFlowEdges flags edges
// that should render with the "active flow" style — the set comes from
// useRunResults.activeFlowEdges() so the canvas doesn't need to know how it
// was derived.
function toRFEdges(
  model: PywrModel,
  selectedEdge: SelectedEdge | null,
  activeFlowEdges: Set<string>,
  tracedTopologyEdges: Set<string>,
): RFEdge[] {
  return model.edges.map((edge, i) => {
    const [from, to] = edge;
    const key = `${from}->${to}`;
    return {
      id: `${key}-${i}`,
      source: from,
      target: to,
      type: "pywr",
      data: {
        active: activeFlowEdges.has(key),
        traced: tracedTopologyEdges.has(key),
      },
      selected:
        selectedEdge !== null &&
        selectedEdge.from === from &&
        selectedEdge.to === to,
    };
  });
}

// Background image that follows the ReactFlow viewport (pans and zooms with nodes).
// Must be rendered inside ReactFlowProvider so useViewport() works.
function ViewportImage({
  src,
  opacity,
}: {
  src: string;
  opacity: number;
}) {
  const { x, y, zoom } = useViewport();
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        transformOrigin: "0 0",
        transform: `translate(${x}px, ${y}px) scale(${zoom})`,
        pointerEvents: "none",
        zIndex: 0,
      }}
    >
      <img
        src={src ?? undefined}
        alt="background map"
        style={{
          display: "block",
          maxWidth: "none",
          opacity,
        }}
        // Let the image render at its natural size in flow-coordinate space.
        // Users calibrate the grid to match the image's real-world scale.
      />
    </div>
  );
}

// Inner component — must be inside ReactFlowProvider to use useReactFlow / useViewport
const CanvasInner = React.forwardRef<CanvasHandle, CanvasProps>(function CanvasInner({
  model,
  positions,
  backgroundImage,
  backgroundOpacity,
  selectedNodeNames,
  selectedEdge,
  editingNodeName,
  highlightedNodeName,
  showLabels,
  gridSize,
  gridSnap,
  placementMode,
  edgeMode,
  edgeSource,
  traceMode,
  traceSummary,
  onNodeSelect,
  onEdgeSelect,
  onTraceModeChange,
  onNodeMove,
  onDeleteRequest,
  onDeleteMultiple,
  onDeleteEdgeRequest,
  onRenameRequest,
  onRenameComplete,
  onAddNode,
  onConnect,
  onPlacementClick,
  activeFlowEdges,
  tracedTopologyEdges,
  tracedNodeRoles,
}: CanvasProps, ref) {
  // Floating context menu — opens on right-click on a node or edge.
  // Replaces the previous "right-click immediately deletes" behaviour.
  const [contextMenu, setContextMenu] = useState<
    | { kind: "node"; name: string; x: number; y: number }
    | { kind: "edge"; from: string; to: string; x: number; y: number }
    | null
  >(null);
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const didFitView = useRef(false);

  useImperativeHandle(ref, () => ({
    zoomToNodes: (ids: string[]) => {
      reactFlowInstance.fitView({ nodes: ids.map(id => ({ id })), duration: 400, padding: 0.4 });
    },
    exportPng: async () => {
      const el = wrapperRef.current?.querySelector(".react-flow__viewport") as HTMLElement | null;
      if (!el) return;
      const { toPng } = await import("html-to-image");
      const dataUrl = await toPng(el, { backgroundColor: "#f8fafc", pixelRatio: 2 });
      const a = document.createElement("a");
      a.href = dataUrl;
      a.download = "pywr-network.png";
      a.click();
    },
  }));

  // Memoize node and edge arrays — prevents ReactFlow from re-reconciling
  // every time a parent state change triggers a re-render.
  const tracedNodeRoleMap = tracedNodeRoles ?? EMPTY_NODE_ROLE_MAP;
  const rfNodes = useMemo(
    () =>
      model
        ? toRFNodes(model, positions, selectedNodeNames, highlightedNodeName, tracedNodeRoleMap, editingNodeName, showLabels, onRenameComplete)
        : [],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [model, positions, selectedNodeNames, highlightedNodeName, tracedNodeRoleMap, editingNodeName, showLabels]
  );

  // Empty-set fallback keeps the dep array stable when no flow data exists
  // yet — without it every render would create a fresh Set and bust memo.
  const activeEdgesSet = activeFlowEdges ?? EMPTY_EDGE_SET;
  const tracedEdgesSet = tracedTopologyEdges ?? EMPTY_EDGE_SET;
  const rfEdges = useMemo(
    () => (model ? toRFEdges(model, selectedEdge, activeEdgesSet, tracedEdgesSet) : []),
    [model, selectedEdge, activeEdgesSet, tracedEdgesSet]
  );

  // Fit view once when the model first loads — not on every subsequent update.
  useEffect(() => {
    if (!model || didFitView.current) return;
    // Short delay so ReactFlow has rendered the nodes before fitting
    const timer = setTimeout(() => {
      reactFlowInstance.fitView({ padding: 0.2 });
      didFitView.current = true;
    }, 50);
    return () => clearTimeout(timer);
  }, [model, reactFlowInstance]);

  // Reset the fitView guard when a new file is opened
  useEffect(() => {
    didFitView.current = false;
  }, [model?.nodes.length === 0 ? null : model?.nodes[0]?.name]);

  // Update position when user drags a node
  const onNodeDragStop = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      onNodeMove(node.id, node.position.x, node.position.y);
    },
    [onNodeMove]
  );

  // Click on node — route everything through onNodeSelect.
  // In edge mode, App.onNodeSelect runs the full state machine
  // (pick source → pick target → addEdge → exit mode, or click source again to cancel).
  // Shift+click adds to / removes from the current selection (non-edge-mode only).
  // Selecting a node clears any edge selection (single-thing-selected rule).
  const onNodeClick = useCallback(
    (event: React.MouseEvent, node: RFNode) => {
      onEdgeSelect(null);
      if (edgeMode) {
        onNodeSelect(node.id);
        return;
      }
      onNodeSelect(node.id, event.shiftKey);
    },
    [edgeMode, onNodeSelect, onEdgeSelect]
  );

  // Click on edge → select it (clears any node selection).
  const onEdgeClick = useCallback(
    (_event: React.MouseEvent, edge: RFEdge) => {
      onNodeSelect(null);
      onEdgeSelect({ from: edge.source, to: edge.target });
    },
    [onEdgeSelect, onNodeSelect]
  );

  // Double-click node → start inline rename
  const onNodeDoubleClick = useCallback(
    (_event: React.MouseEvent, node: RFNode) => {
      onRenameRequest(node.id);
    },
    [onRenameRequest]
  );

  const onPaneClick = useCallback(
    (e: React.MouseEvent) => {
      if (placementMode) {
        // screenToFlowPosition expects client/viewport coordinates directly —
        // it internally subtracts the container bounds. Do NOT subtract bounds here.
        const position = reactFlowInstance.screenToFlowPosition({
          x: e.clientX,
          y: e.clientY,
        });
        onPlacementClick(position.x, position.y, e.clientX, e.clientY);
        return;
      }
      onNodeSelect(null);
      onEdgeSelect(null);
    },
    [placementMode, onPlacementClick, onNodeSelect, onEdgeSelect, reactFlowInstance]
  );

  // Drag between handles → create edge
  const handleConnect = useCallback(
    (connection: Connection) => {
      if (connection.source && connection.target) {
        onConnect(connection.source, connection.target);
      }
    },
    [onConnect]
  );

  // Right-click node → open context menu (Rename, Delete).
  // Replaces the previous "right-click immediately deletes" behaviour.
  const onNodeContextMenu = useCallback(
    (e: React.MouseEvent, node: RFNode) => {
      e.preventDefault();
      setContextMenu({ kind: "node", name: node.id, x: e.clientX, y: e.clientY });
    },
    [],
  );

  // Right-click edge → open context menu (Delete).
  const onEdgeContextMenu = useCallback(
    (e: React.MouseEvent, edge: RFEdge) => {
      e.preventDefault();
      setContextMenu({
        kind: "edge",
        from: edge.source,
        to: edge.target,
        x: e.clientX,
        y: e.clientY,
      });
    },
    [],
  );

  // Delete/Backspace key → routes by current selection.
  //   selectedEdge      → confirmation dialog for that edge
  //   selectedNodeNames → batch (>1) or single dialog
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Delete" && e.key !== "Backspace") return;
      // Don't intercept Backspace while typing in an input/textarea
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || (e.target as HTMLElement).isContentEditable) return;

      if (selectedEdge) {
        e.preventDefault();
        onDeleteEdgeRequest(selectedEdge.from, selectedEdge.to);
        return;
      }
      if (selectedNodeNames.length === 0) return;
      e.preventDefault();
      if (selectedNodeNames.length > 1) {
        onDeleteMultiple(selectedNodeNames);
      } else {
        onDeleteRequest(selectedNodeNames[0]);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedNodeNames, selectedEdge, onDeleteRequest, onDeleteMultiple, onDeleteEdgeRequest]);

  // Build the items shown in the floating context menu, based on what was
  // right-clicked. The menu component itself handles outside-click + Esc.
  const contextMenuItems: ContextMenuItem[] = useMemo(() => {
    if (!contextMenu) return [];
    if (contextMenu.kind === "node") {
      return [
        { label: "Rename", onClick: () => onRenameRequest(contextMenu.name) },
        {
          label: "Delete",
          danger: true,
          onClick: () => onDeleteRequest(contextMenu.name),
        },
      ];
    }
    return [
      {
        label: "Delete",
        danger: true,
        onClick: () => onDeleteEdgeRequest(contextMenu.from, contextMenu.to),
      },
    ];
  }, [contextMenu, onRenameRequest, onDeleteRequest, onDeleteEdgeRequest]);

  // Drag-and-drop from NodePalette
  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const nodeType = e.dataTransfer.getData("application/pywr-node-type");
      if (!nodeType) return;

      // screenToFlowPosition (RF 11.10+) takes client/viewport coordinates and
      // handles the container offset internally. Do NOT subtract bounds here.
      const position = reactFlowInstance.screenToFlowPosition({
        x: e.clientX,
        y: e.clientY,
      });
      onAddNode(nodeType, position.x, position.y);
    },
    [reactFlowInstance, onAddNode]
  );

  return (
    <div
      ref={wrapperRef}
      className={(placementMode || edgeMode) ? "pywr-mode-active" : undefined}
      style={{ flex: 1, position: "relative", overflow: "hidden" }}
      onDrop={onDrop}
      onDragOver={onDragOver}
    >
      {(placementMode || edgeMode) && (
        <div style={{
          position: "absolute", top: 0, left: 0, right: 0, zIndex: 10,
          backgroundColor: edgeMode ? (edgeSource ? "#0d7a5f" : "#7c3aed") : "#1a73e8",
          color: "#fff", textAlign: "center", fontSize: 12, padding: "5px",
          pointerEvents: "none",
        }}>
          {placementMode && "Click to place node — drag to pan — Esc to cancel"}
          {edgeMode && !edgeSource && "Click SOURCE node — drag to pan — Esc to cancel"}
          {edgeMode && edgeSource && `Source: "${edgeSource}" — click TARGET, or click "${edgeSource}" again to cancel`}
        </div>
      )}

      {/* Background map — rendered with viewport transform so it pans and zooms
          in sync with the nodes. Placed before ReactFlow in DOM so it's behind. */}
      {backgroundImage && (
        <ViewportImage
          src={backgroundImage}
          opacity={backgroundOpacity}
        />
      )}

      <TraceControls
        mode={traceMode}
        summary={traceSummary}
        onChange={onTraceModeChange}
      />

      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onEdgeClick={onEdgeClick}
        onPaneClick={onPaneClick}
        onConnect={handleConnect}
        onNodeContextMenu={onNodeContextMenu}
        onEdgeContextMenu={onEdgeContextMenu}
        deleteKeyCode={null}       // we show a confirmation dialog instead
        snapToGrid={gridSnap}
        snapGrid={[gridSize, gridSize]}
        panOnDrag={[0, 1, 2]}      // pan always: ReactFlow distinguishes click from drag by movement threshold,
                                   // so onPaneClick still fires on a true click in placement mode.
        zoomOnScroll={true}        // scroll wheel to zoom
        zoomOnPinch={true}         // trackpad pinch to zoom
        zoomOnDoubleClick={false}  // double-click is reserved for inline rename;
                                   // also stops "two rapid placement clicks → zoom"
        panOnScroll={false}        // keep scroll as zoom, not pan
        minZoom={0.05}             // allow zooming far out to see full map
        maxZoom={8}                // allow zooming in to trace fine detail
        connectionLineStyle={{ stroke: "#9ca3af", strokeWidth: 1, strokeDasharray: "4 3" }}
        connectionLineType={ConnectionLineType.Straight}
        connectOnClick={false}
        style={{ background: "transparent", position: "relative", zIndex: 1 }}
      >
        {/* Grid: lines mode when snap is on (gap matches snap size), subtle dots otherwise */}
        <Background
          variant={gridSnap ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={gridSnap ? gridSize : 20}
          color={gridSnap ? "#3a5068" : "#c8cdd2"}
          lineWidth={gridSnap ? 0.5 : undefined}
        />
        <Controls showInteractive={false} />
        <MiniMap zoomable pannable />
      </ReactFlow>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
});

function TraceControls({
  mode,
  summary,
  onChange,
}: {
  mode: TraceMode;
  summary: TraceSummary | null;
  onChange: (mode: TraceMode) => void;
}) {
  return (
    <div
      style={{
        position: "absolute",
        top: 12,
        right: 12,
        zIndex: 20,
        width: 280,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        pointerEvents: "auto",
      }}
    >
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(4, 1fr)",
          gap: 4,
          padding: 4,
          background: "rgba(15,23,42,0.9)",
          border: "1px solid rgba(148,163,184,0.35)",
          borderRadius: 6,
          boxShadow: "0 8px 20px rgba(15,23,42,0.22)",
        }}
      >
        {(["both", "upstream", "downstream", "active"] as const).map((m) => (
          <button
            key={m}
            onClick={() => onChange(m)}
            title={traceModeTitle(m)}
            style={{
              border: "none",
              borderRadius: 4,
              padding: "5px 4px",
              fontSize: 10,
              fontWeight: 700,
              color: mode === m ? "#0f172a" : "#cbd5e1",
              background: mode === m ? "#e2e8f0" : "transparent",
              cursor: "pointer",
            }}
          >
            {traceModeLabel(m)}
          </button>
        ))}
      </div>

      {summary && (
        <div
          style={{
            background: "rgba(255,255,255,0.94)",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            boxShadow: "0 8px 20px rgba(15,23,42,0.18)",
            padding: 10,
            color: "#0f172a",
          }}
        >
          <div style={{ fontSize: 11, color: "#64748b", marginBottom: 2 }}>
            {summary.nodeType}
          </div>
          <div
            title={summary.selectedName}
            style={{
              fontSize: 13,
              fontWeight: 800,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginBottom: 8,
            }}
          >
            {summary.selectedName}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}>
            <SummaryMetric label="In" value={summary.inboundCount} />
            <SummaryMetric label="Out" value={summary.outboundCount} />
            <SummaryMetric label="Upstream" value={summary.upstreamCount} tone="#f59e0b" />
            <SummaryMetric label="Downstream" value={summary.downstreamCount} tone="#0ea5e9" />
            <SummaryMetric label="Trace edges" value={summary.tracedEdgeCount} tone="#8b5cf6" />
            <SummaryMetric label="Active edges" value={summary.activeEdgeCount} tone="#10b981" />
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryMetric({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone?: string;
}) {
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 10, color: "#64748b" }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 800, color: tone ?? "#0f172a" }}>
        {value.toLocaleString()}
      </div>
    </div>
  );
}

function traceModeLabel(mode: TraceMode): string {
  switch (mode) {
    case "both": return "Both";
    case "upstream": return "Up";
    case "downstream": return "Down";
    case "active": return "Active";
  }
}

function traceModeTitle(mode: TraceMode): string {
  switch (mode) {
    case "both": return "Show upstream and downstream topology";
    case "upstream": return "Show only nodes and edges feeding the selected node";
    case "downstream": return "Show only nodes and edges reached from the selected node";
    case "active": return "Show only result-backed active-flow edges after a run";
  }
}

// Exported wrapper — provides ReactFlowProvider context and forwards ref
export const Canvas = React.forwardRef<CanvasHandle, CanvasProps>((props, ref) => {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} ref={ref} />
    </ReactFlowProvider>
  );
});

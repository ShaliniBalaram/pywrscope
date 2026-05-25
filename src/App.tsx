// src/App.tsx - PywrScope root component
// Wires together all hooks and components.

import React, { useState, useCallback, useRef } from "react";
import { usePywrJson } from "./hooks/usePywrJson";
import { useLayout } from "./hooks/useLayout";
import { useRecentFiles } from "./hooks/useRecentFiles";
import { useModelRun } from "./hooks/useModelRun";
import { useRunResults, activeFlowEdges as computeActiveFlowEdges } from "./hooks/useRunResults";
import { RunPanel } from "./components/RunPanel";
import { Canvas, CanvasHandle, TraceMode, TraceSummary } from "./components/Canvas";
import { NodePalette, createNodeFromDrop } from "./components/NodePalette";
import { PropertiesPanel } from "./components/PropertiesPanel";
import { DeleteNodeDialog } from "./components/DeleteNodeDialog";
import { DeleteEdgeDialog } from "./components/DeleteEdgeDialog";
import { ValidationBar } from "./components/ValidationBar";
import { Toolbar } from "./components/Toolbar";
import { TabBar, AppTab } from "./components/TabBar";
import { JsonEditor } from "./components/JsonEditor";
import { MapView } from "./components/MapView";
import { ResultsViewer } from "./components/ResultsViewer";
import { ResultsTab } from "./components/ResultsTab";
import { HistoryPanel } from "./components/HistoryPanel";
import { SaveBeforeCloseDialog } from "./components/SaveBeforeCloseDialog";
import { AddNodeModal } from "./components/AddNodeModal";
import { RecorderManager } from "./components/RecorderManager";
import { NodePlacementPopup } from "./components/NodePlacementPopup";
import { SearchOverlay } from "./components/SearchOverlay";
import { StatusBar } from "./components/StatusBar";
import { PywrNode, PywrModel } from "./types/pywr";
import { embedPositions } from "./utils/embedPositions";
import { extractNodePosition } from "./utils/nodePosition";
import { computePywrModelLayout } from "./utils/dagreLayout";
import { nextEdgeStep } from "./utils/edgeMode";

// Normalise schematic coordinates (which may be OS grid refs in the 100,000s)
// to a canvas-friendly pixel space. If the range is already small (<5000 units)
// it's already pixel-scale, so leave it alone.
function normalizePositions(
  coords: Record<string, { x: number; y: number }>
): Record<string, { x: number; y: number }> {
  const entries = Object.entries(coords);
  if (entries.length === 0) return coords;

  const xs = entries.map(([, p]) => p.x);
  const ys = entries.map(([, p]) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const rangeX = maxX - minX;
  const rangeY = maxY - minY;

  // Already canvas-scale — no normalisation needed.
  if (rangeX < 5000 && rangeY < 5000) return coords;

  // Scale uniformly so the whole network fits within ~3000×2000 px with padding.
  const TARGET = 3000;
  const PADDING = 150;
  const scale = (TARGET - 2 * PADDING) / Math.max(rangeX, rangeY, 1);

  const result: Record<string, { x: number; y: number }> = {};
  for (const [name, pos] of entries) {
    result[name] = {
      x: Math.round(PADDING + (pos.x - minX) * scale),
      y: Math.round(PADDING + (pos.y - minY) * scale),
    };
  }
  return result;
}

function initialPositionsForModel(model: PywrModel): Record<string, { x: number; y: number }> {
  const generated = computePywrModelLayout(model);
  const fromNodeCoords: Record<string, { x: number; y: number }> = {};
  for (const node of model.nodes) {
    const p = extractNodePosition(node);
    if (p) fromNodeCoords[node.name] = p;
  }

  const existing = normalizePositions(fromNodeCoords);
  return { ...generated, ...existing };
}

// Find an empty spot on the canvas that doesn't overlap existing nodes.
// Searches outward from the centroid of existing nodes in a spiral.
function findEmptySpot(
  positions: Record<string, { x: number; y: number }>
): { x: number; y: number } {
  const pts = Object.values(positions);
  if (pts.length === 0) return { x: 400, y: 300 };

  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  const MIN = 130; // minimum clear radius around each node

  for (let r = MIN; r < 3000; r += MIN) {
    for (let deg = 0; deg < 360; deg += 20) {
      const rad = (deg * Math.PI) / 180;
      const x = Math.round(cx + r * Math.cos(rad));
      const y = Math.round(cy + r * Math.sin(rad));
      if (!pts.some(p => Math.hypot(p.x - x, p.y - y) < MIN)) {
        return { x, y };
      }
    }
  }
  return { x: Math.round(cx + 200), y: Math.round(cy + 200) };
}

interface TopologyTrace {
  upstreamNodes: Set<string>;
  downstreamNodes: Set<string>;
  upstreamEdges: Set<string>;
  downstreamEdges: Set<string>;
  inboundCount: number;
  outboundCount: number;
}

function topologyTrace(model: PywrModel, startNode: string): TopologyTrace {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();

  for (const edge of model.edges) {
    const [from, to] = edge;
    if (!from || !to) continue;
    if (!outgoing.has(from)) outgoing.set(from, []);
    if (!incoming.has(to)) incoming.set(to, []);
    outgoing.get(from)!.push(to);
    incoming.get(to)!.push(from);
  }

  const walk = (
    initial: string,
    nextMap: Map<string, string[]>,
    keyFor: (from: string, to: string) => string,
  ): { nodes: Set<string>; edges: Set<string> } => {
    const nodes = new Set<string>();
    const edges = new Set<string>();
    const seen = new Set<string>([initial]);
    const queue = [initial];
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of nextMap.get(current) ?? []) {
        edges.add(keyFor(current, next));
        nodes.add(next);
        if (!seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
    return { nodes, edges };
  };

  const downstream = walk(startNode, outgoing, (from, to) => `${from}->${to}`);
  const upstream = walk(startNode, incoming, (to, from) => `${from}->${to}`);
  return {
    upstreamNodes: upstream.nodes,
    downstreamNodes: downstream.nodes,
    upstreamEdges: upstream.edges,
    downstreamEdges: downstream.edges,
    inboundCount: incoming.get(startNode)?.length ?? 0,
    outboundCount: outgoing.get(startNode)?.length ?? 0,
  };
}

export default function App() {
  // Unified undo/redo order — tracks whether each action was a model change or
  // a position change (layout), so Cmd+Z restores them in the correct sequence.
  const undoOrderRef = React.useRef<Array<"model" | "position">>([]);
  const redoOrderRef = React.useRef<Array<"model" | "position">>([]);

  const pywrJson = usePywrJson({
    onPushHistory: React.useCallback(() => {
      undoOrderRef.current = [...undoOrderRef.current, "model"];
      redoOrderRef.current = [];
    }, []),
    onClearHistory: React.useCallback(() => {
      undoOrderRef.current = [];
      redoOrderRef.current = [];
    }, []),
  });
  const layout = useLayout();
  const { recentFiles, addRecentFile } = useRecentFiles();
  const run = useModelRun();
  // Loads summary.json after a run completes and derives per-node flow values.
  // Lives at App level so both the Canvas (edge highlighting) and the Results
  // tab read from the same source — avoids "edge says active, panel says zero".
  const runResults = useRunResults(pywrJson.model, run.state);

  // Mirror layout.positions → model.nodes[*].position on every layout change.
  // This keeps the JSON tab honest: whatever you see is what gets saved.
  // updateNodePositions is a no-op when positions are already in sync, so
  // model→layout→model can't ping-pong infinitely.
  React.useEffect(() => {
    if (!pywrJson.model) return;
    pywrJson.updateNodePositions(layout.positions);
    // Intentionally exclude pywrJson from deps: it's a stable hook return,
    // and including it would re-fire on every model change (which this
    // effect itself triggers), creating a loop. layout.positions is the
    // sole driver — when the user moves a node, this fires once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.positions]);

  const [activeTab, setActiveTab] = useState<AppTab>("canvas");
  const [selectedNodeName, setSelectedNodeName] = useState<string | null>(null);
  const [selectedNodeNames, setSelectedNodeNames] = useState<string[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [batchDeleteTargets, setBatchDeleteTargets] = useState<string[]>([]);
  const [selectedEdge, setSelectedEdge] = useState<{ from: string; to: string } | null>(null);
  const [deleteEdgeTarget, setDeleteEdgeTarget] = useState<{ from: string; to: string } | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [editingNodeName, setEditingNodeName] = useState<string | null>(null);
  const canvasRef = useRef<CanvasHandle>(null);
  const clipboardRef = useRef<{ nodes: PywrNode[]; positions: Record<string, { x: number; y: number }> } | null>(null);
  const [highlightedNodeName, setHighlightedNodeName] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [gridSize, setGridSize] = useState(20);
  const [gridSnap, setGridSnap] = useState(false);
  const [gridLocked, setGridLocked] = useState(false);
  const [showAddNodeModal, setShowAddNodeModal] = useState(false);
  const [showCloseDialog, setShowCloseDialog] = useState(false);
  const [placementMode, setPlacementMode] = useState(false);
  const [placementData, setPlacementData] = useState<{flowX: number; flowY: number; screenX: number; screenY: number; defaultName: string} | null>(null);
  const [edgeMode, setEdgeMode] = useState(false);
  const [edgeSource, setEdgeSource] = useState<string | null>(null);
  const [traceMode, setTraceMode] = useState<TraceMode>("both");
  // Results viewer state. `null` = closed; a string (or empty string) = open.
  // When the value is a non-empty path, the viewer opens directly on that
  // file; an empty string opens the viewer in its idle "Browse…" state.
  const [resultsViewerPath, setResultsViewerPath] = useState<string | null>(null);
  const [showRunPanel, setShowRunPanel] = useState(false);

  const selectedNode = selectedNodeNames.length === 1
    ? pywrJson.getNodeByName(selectedNodeNames[0])
    : undefined;

  // Edges that should render highlighted as carrying active flow downstream
  // of the currently-selected node. Empty until (a) a model is loaded, (b) a
  // run has completed, and (c) exactly one node is selected. Recomputed only
  // when any of those inputs change — model.edges is the big input but it's
  // stable across normal interactions.
  const activeFlowEdges = React.useMemo(() => {
    if (!pywrJson.model) return new Set<string>();
    if (selectedNodeNames.length !== 1) return new Set<string>();
    if (runResults.activeNodes.size === 0) return new Set<string>();
    return computeActiveFlowEdges(
      pywrJson.model,
      selectedNodeNames[0],
      runResults.activeNodes,
    );
  }, [pywrJson.model, selectedNodeNames, runResults.activeNodes]);

  const topology = React.useMemo(() => {
    if (!pywrJson.model) return null;
    if (selectedNodeNames.length !== 1) return null;
    return topologyTrace(pywrJson.model, selectedNodeNames[0]);
  }, [pywrJson.model, selectedNodeNames]);

  const tracedTopologyEdges = React.useMemo(() => {
    if (!topology || traceMode === "active") return new Set<string>();
    if (traceMode === "upstream") return topology.upstreamEdges;
    if (traceMode === "downstream") return topology.downstreamEdges;
    return new Set([...topology.upstreamEdges, ...topology.downstreamEdges]);
  }, [topology, traceMode]);

  const tracedNodeRoles = React.useMemo(() => {
    const roles = new Map<string, "upstream" | "downstream" | "both">();
    if (!topology || traceMode === "active") return roles;
    if (traceMode !== "downstream") {
      for (const name of topology.upstreamNodes) roles.set(name, "upstream");
    }
    if (traceMode !== "upstream") {
      for (const name of topology.downstreamNodes) {
        roles.set(name, roles.has(name) ? "both" : "downstream");
      }
    }
    return roles;
  }, [topology, traceMode]);

  const traceSummary = React.useMemo<TraceSummary | null>(() => {
    if (!pywrJson.model || !topology || selectedNodeNames.length !== 1) return null;
    const selectedName = selectedNodeNames[0];
    const node = pywrJson.model.nodes.find((n) => n.name === selectedName);
    return {
      selectedName,
      nodeType: node?.type ?? "Node",
      inboundCount: topology.inboundCount,
      outboundCount: topology.outboundCount,
      upstreamCount: topology.upstreamNodes.size,
      downstreamCount: topology.downstreamNodes.size,
      tracedEdgeCount: tracedTopologyEdges.size,
      activeEdgeCount: activeFlowEdges.size,
    };
  }, [pywrJson.model, topology, selectedNodeNames, tracedTopologyEdges, activeFlowEdges]);

  // -----------------------------------------------------------------------
  // New model: blank canvas, ready to add nodes and a background image
  // -----------------------------------------------------------------------
  const handleNew = useCallback(() => {
    pywrJson.newModel();
    layout.resetLayout();
    setSelectedNodeName(null);
    setSelectedNodeNames([]);
    setEditingNodeName(null);
    setDeleteTarget(null);
    setBatchDeleteTargets([]);
    setShowSearch(false);
    setPlacementMode(false);
    setEdgeMode(false);
    setEdgeSource(null);
    run.reset();
    setShowRunPanel(false);
    prevPath.current = null;
  }, [pywrJson, layout, run.reset]);

  // -----------------------------------------------------------------------
  // Open a specific path directly (from recent files list)
  // -----------------------------------------------------------------------
  const handleOpenRecent = useCallback(async (path: string) => {
    try {
      const response = await window.pywr.callApi("/api/parse", { json_path: path });
      const resp = response as { ok: boolean; data?: PywrModel; error?: string };
      if (!resp.ok || !resp.data) return;
      pywrJson.loadAtPath(path, resp.data);
      // Reset prevPath so the layout effect fires when currentPath updates
      prevPath.current = null;
      addRecentFile(path);
    } catch {
      // silently ignore — stale path
    }
  }, [pywrJson, addRecentFile]);

  // -----------------------------------------------------------------------
  // Auto-layout: re-arrange all nodes using dagre topology
  // -----------------------------------------------------------------------
  const handleAutoLayout = useCallback(() => {
    if (!pywrJson.model) return;
    // Snapshot positions BEFORE layout so Cmd+Z can restore them
    layout.pushPositionHistory();
    undoOrderRef.current = [...undoOrderRef.current, "position"];
    redoOrderRef.current = [];
    const positions = computePywrModelLayout(pywrJson.model);
    layout.setAllPositions(positions);
    pywrJson.updateNodePositions(positions);
  }, [pywrJson, layout]);

  // -----------------------------------------------------------------------
  // Open file: parse model then load layout sidecar
  // -----------------------------------------------------------------------
  const handleOpen = useCallback(async () => {
    await pywrJson.openFile();
    // After openFile, pywrJson.currentPath is set
    // Load layout for the new file (auto-layout if no sidecar exists)
    // We do this in an effect below via currentPath change
  }, [pywrJson]);

  const startRun = useCallback(() => {
    if (!pywrJson.currentPath) return;
    setShowRunPanel(true);
    void run.start(pywrJson.currentPath);
  }, [pywrJson.currentPath, run.start]);

  // When currentPath changes (new file opened), load layout + record in recent files
  const prevPath = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (pywrJson.currentPath && pywrJson.model && pywrJson.currentPath !== prevPath.current) {
      prevPath.current = pywrJson.currentPath;
      run.reset();
      setShowRunPanel(false);
      addRecentFile(pywrJson.currentPath);
      layout.loadLayout(pywrJson.currentPath).then((hasSidecarPositions) => {
        if (hasSidecarPositions) {
          // Sidecar had positions — nothing more to do.
          return;
        }

        // No sidecar: preserve any embedded Pywr positions, generate only the
        // missing ones, and immediately write the merged layout back into the
        // in-memory JSON so the JSON tab is honest before the user saves.
        const positions = initialPositionsForModel(pywrJson.model!);
        layout.setAllPositions(positions);
        pywrJson.updateNodePositions(positions);
      });
    }
  }, [pywrJson.currentPath, pywrJson.model, layout, run.reset]);

  // -----------------------------------------------------------------------
  // Save: export model + write layout sidecar
  // -----------------------------------------------------------------------
  const handleSave = useCallback(async () => {
    if (!pywrJson.model) return;
    setSaveError(null);

    const defaultPath = pywrJson.currentPath ?? "model.json";
    const savePath = await window.pywr.saveFile(defaultPath);
    if (!savePath) return; // user cancelled

    const modelToExport = embedPositions(pywrJson.model, layout.positions);
    const response = await window.pywr.callApi("/api/export", {
      model: modelToExport,
      output_path: savePath,
    });
    const resp = response as { ok: boolean; error?: string };
    if (!resp.ok) {
      setSaveError(resp.error ?? "Export failed");
      return;
    }

    // Write layout sidecar alongside the model file
    await layout.saveLayout(savePath);
    pywrJson.markSaved();
  }, [pywrJson, layout]);

  // -----------------------------------------------------------------------
  // performSave — saves to proposedPath (shown in close dialog), returns
  // true if the file was actually written, false if user cancelled.
  // -----------------------------------------------------------------------
  const performSave = useCallback(async (proposedPath: string): Promise<boolean> => {
    if (!pywrJson.model) return false;
    setSaveError(null);
    const savePath = await window.pywr.saveFile(proposedPath);
    if (!savePath) return false;
    const modelToExport = embedPositions(pywrJson.model, layout.positions);
    const response = await window.pywr.callApi("/api/export", {
      model: modelToExport,
      output_path: savePath,
    });
    const resp = response as { ok: boolean; error?: string };
    if (!resp.ok) {
      setSaveError(resp.error ?? "Export failed");
      return false;
    }
    await layout.saveLayout(savePath);
    pywrJson.markSaved();
    return true;
  }, [pywrJson, layout]);

  // -----------------------------------------------------------------------
  // Intercept Tauri window-close: show save dialog if there are unsaved changes
  // -----------------------------------------------------------------------
  // Use refs so the close listener never needs to be re-registered
  const forceCloseRef = React.useRef(false);
  const isDirtyRef = React.useRef(false);
  React.useEffect(() => { isDirtyRef.current = pywrJson.isDirty; }, [pywrJson.isDirty]);

  const doClose = React.useCallback(() => {
    forceCloseRef.current = true;
    isDirtyRef.current = false;
    window.pywr.quit();
  }, []);

  // Register once — reads from refs so no stale-closure problem
  React.useEffect(() => {
    let unlisten: (() => void) | null = null;
    import("@tauri-apps/api/window").then(({ getCurrentWindow }) => {
      getCurrentWindow().onCloseRequested((event) => {
        if (isDirtyRef.current && !forceCloseRef.current) {
          event.preventDefault();
          setShowCloseDialog(true);
        }
      }).then((fn) => { unlisten = fn; });
    });
    return () => { unlisten?.(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // -----------------------------------------------------------------------
  // Load background map image
  // -----------------------------------------------------------------------
  const handleLoadImage = useCallback(async () => {
    const imagePath = await window.pywr.openImage();
    if (imagePath) {
      layout.setBackgroundImage(imagePath);
    }
  }, [layout]);

  // -----------------------------------------------------------------------
  // Add node — from palette drop or modal (modal places at staggered centre)
  // -----------------------------------------------------------------------
  const handleAddNode = useCallback(
    (nodeType: string, x: number, y: number) => {
      if (!pywrJson.model) return;
      const existingNames = new Set(pywrJson.model.nodes.map((n) => n.name));
      const { node, name } = createNodeFromDrop(nodeType, x, y, existingNames);
      pywrJson.addNode(node);
      layout.setPosition(name, x, y);
    },
    [pywrJson, layout]
  );

  // Stagger successive modal-placed nodes so they don't all pile up
  const modalPlaceCounter = React.useRef(0);
  const handleAddNodeFromModal = useCallback(
    (nodeType: string) => {
      const offset = (modalPlaceCounter.current % 6) * 30;
      modalPlaceCounter.current += 1;
      handleAddNode(nodeType, 300 + offset, 200 + offset);
    },
    [handleAddNode]
  );

  // -----------------------------------------------------------------------
  // Add edge by connecting handles on the canvas
  // -----------------------------------------------------------------------
  const handleConnect = useCallback(
    (from: string, to: string) => {
      pywrJson.addEdge(from, to);
    },
    [pywrJson]
  );

  // -----------------------------------------------------------------------
  // JSON editor tab — apply full model replacement
  // -----------------------------------------------------------------------
  const handleJsonApply = useCallback(
    (newModel: PywrModel) => {
      pywrJson.replaceModel(newModel);
    },
    [pywrJson]
  );

  // -----------------------------------------------------------------------
  // CSV parameter linking — creates a named CSVParameter in model.parameters
  // and sets the node field to the parameter name
  // -----------------------------------------------------------------------
  const handleLinkCsv = useCallback(
    (fieldKey: string, csvPath: string, column: string) => {
      const name = selectedNodeNames[0];
      if (!name) return;
      const paramName = `${name}__${fieldKey}`;
      pywrJson.addParameter(paramName, {
        type: "CSVParameter",
        url: csvPath,
        column: column,
        index_col: "Date",
      });
      pywrJson.updateNode(name, { [fieldKey]: paramName } as Partial<PywrNode>);
    },
    [pywrJson, selectedNodeNames]
  );

  // -----------------------------------------------------------------------
  // Keyboard shortcuts
  // -----------------------------------------------------------------------
  React.useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "Escape") {
        setPlacementMode(false);
        setEdgeMode(false);
        setEdgeSource(null);
        setShowSearch(false);
        setEditingNodeName(null);
        setSelectedEdge(null);
      } else if (mod && e.key === "n") {
        e.preventDefault();
        handleNew();
      } else if (mod && e.key === "o" && !e.shiftKey) {
        e.preventDefault();
        handleOpen();
      } else if (mod && e.key === "s" && !e.shiftKey) {
        e.preventDefault();
        handleSave();
      } else if (mod && e.key === "f") {
        e.preventDefault();
        if (pywrJson.model) setShowSearch(true);
      } else if (mod && e.shiftKey && (e.key === "F" || e.key === "f")) {
        e.preventDefault();
        if (selectedNodeNames.length > 0) canvasRef.current?.zoomToNodes(selectedNodeNames);
      } else if (mod && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        const lastAction = undoOrderRef.current[undoOrderRef.current.length - 1];
        if (lastAction === "position" && layout.canUndoPositions) {
          layout.undoPositions();
          redoOrderRef.current = [...redoOrderRef.current, "position"];
          undoOrderRef.current = undoOrderRef.current.slice(0, -1);
        } else if (pywrJson.canUndo) {
          pywrJson.undo();
          redoOrderRef.current = [...redoOrderRef.current, "model"];
          if (lastAction === "model") undoOrderRef.current = undoOrderRef.current.slice(0, -1);
        }
      } else if (mod && (e.key === "Z" || (e.key === "z" && e.shiftKey))) {
        e.preventDefault();
        const nextAction = redoOrderRef.current[redoOrderRef.current.length - 1];
        if (nextAction === "position" && layout.canRedoPositions) {
          layout.redoPositions();
          undoOrderRef.current = [...undoOrderRef.current, "position"];
          redoOrderRef.current = redoOrderRef.current.slice(0, -1);
        } else if (pywrJson.canRedo) {
          pywrJson.redo();
          undoOrderRef.current = [...undoOrderRef.current, "model"];
          if (nextAction === "model") redoOrderRef.current = redoOrderRef.current.slice(0, -1);
        }
      } else if (mod && e.key === "c") {
        if (selectedNodeNames.length > 0 && pywrJson.model) {
          e.preventDefault();
          const nodes = selectedNodeNames
            .map(n => pywrJson.getNodeByName(n))
            .filter((n): n is PywrNode => !!n);
          const positions = Object.fromEntries(
            selectedNodeNames.map(n => [n, layout.positions[n] ?? { x: 0, y: 0 }])
          );
          clipboardRef.current = { nodes, positions };
        }
      } else if (mod && e.key === "v") {
        if (clipboardRef.current && pywrJson.model) {
          e.preventDefault();
          const existingNames = new Set(pywrJson.model.nodes.map(n => n.name));
          const OFFSET = 60;
          const newNames: string[] = [];
          for (const node of clipboardRef.current.nodes) {
            let newName = `${node.name}_copy`;
            let i = 2;
            while (existingNames.has(newName)) newName = `${node.name}_copy${i++}`;
            existingNames.add(newName);
            newNames.push(newName);
            const pos = clipboardRef.current.positions[node.name] ?? { x: 300, y: 300 };
            pywrJson.addNode({ ...node, name: newName });
            layout.setPosition(newName, pos.x + OFFSET, pos.y + OFFSET);
          }
          setSelectedNodeNames(newNames);
          if (newNames.length === 1) setSelectedNodeName(newNames[0]);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pywrJson, handleNew, handleOpen, handleSave]);

  // -----------------------------------------------------------------------
  // Highlight a node from the validation bar for 2s
  // -----------------------------------------------------------------------
  const handleNodeHighlight = useCallback((name: string) => {
    setHighlightedNodeName(name);
    setTimeout(() => setHighlightedNodeName(null), 2000);
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        overflow: "hidden",
        fontFamily: "sans-serif",
      }}
    >
      {/* Top toolbar — always visible */}
      <Toolbar
        hasModel={!!pywrJson.model}
        isDirty={pywrJson.isDirty}
        canUndo={pywrJson.canUndo}
        canRedo={pywrJson.canRedo}
        backgroundOpacity={layout.backgroundOpacity}
        backgroundImage={layout.backgroundImage}
        gridSize={gridSize}
        gridSnap={gridSnap}
        gridLocked={gridLocked}
        onNew={handleNew}
        onOpen={handleOpen}
        onSave={handleSave}
        onUndo={pywrJson.undo}
        onRedo={pywrJson.redo}
        onAddNode={() => {
          if (!pywrJson.model) return;
          setPlacementMode(true);
        }}
        onAddEdge={() => { if (pywrJson.model) { setEdgeMode(e => !e); setEdgeSource(null); } }}
        edgeMode={edgeMode}
        hasSelection={selectedNodeNames.length > 0}
        deleteSelection={
          selectedEdge ? "edge"
          : selectedNodeNames.length > 1 ? "nodes"
          : selectedNodeNames.length === 1 ? "node"
          : "none"
        }
        onDelete={() => {
          if (selectedEdge) {
            setDeleteEdgeTarget(selectedEdge);
          } else if (selectedNodeNames.length > 1) {
            setBatchDeleteTargets(selectedNodeNames);
          } else if (selectedNodeNames.length === 1) {
            setDeleteTarget(selectedNodeNames[0]);
          }
        }}
        onLoadImage={handleLoadImage}
        onOpacityChange={layout.setBackgroundOpacity}
        onGridSizeChange={setGridSize}
        onGridSnapToggle={() => setGridSnap((s) => !s)}
        onGridLockToggle={() => setGridLocked((l) => !l)}
        showLabels={showLabels}
        onToggleLabels={() => setShowLabels(v => !v)}
        onSearch={() => { if (pywrJson.model) setShowSearch(true); }}
        onZoomToSelection={() => { if (selectedNodeNames.length > 0) canvasRef.current?.zoomToNodes(selectedNodeNames); }}
        onExportPng={() => canvasRef.current?.exportPng()}
        recentFiles={recentFiles}
        onOpenRecent={handleOpenRecent}
        onAutoLayout={handleAutoLayout}
        onRun={startRun}
        runDisabledReason={
          // Carve-outs in priority order: no model loaded → no path → unsaved
          // edits → already running. Each reason is a tooltip on the disabled
          // button so the user knows what to do next.
          !pywrJson.model
            ? "Open or create a model first"
            : !pywrJson.currentPath
              ? "Save the model to a file before running"
            : pywrJson.hasRunBlockingChanges
                ? "Save your changes before running"
                : run.state.status === "running" || run.state.status === "starting"
                  ? "A run is already in progress"
                  : null
        }
      />

      {/* Tab bar */}
      <TabBar
        activeTab={activeTab}
        hasModel={!!pywrJson.model}
        onTabChange={setActiveTab}
      />

      {/* Main content — tab panels + validation bar */}
      <div style={{ display: "flex", flex: 1, overflow: "hidden", flexDirection: "column" }}>

        {/* Tab panels — all absolutely positioned inside a relative wrapper.
            This avoids a WKWebView (macOS) bug where a display:none flex child
            with flex-grow:1 still consumes flex space, starving visible siblings. */}
        <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>

          {/* Canvas panel — always in DOM so ReactFlow state is preserved */}
          <div style={{
            position: "absolute", inset: 0,
            display: activeTab === "canvas" ? "flex" : "none",
            overflow: "hidden",
          }}>
            <Canvas
              ref={canvasRef}
              model={pywrJson.model}
              positions={layout.positions}
              backgroundImage={layout.backgroundImage}
              backgroundOpacity={layout.backgroundOpacity}
              activeFlowEdges={activeFlowEdges}
              tracedTopologyEdges={tracedTopologyEdges}
              tracedNodeRoles={tracedNodeRoles}
              selectedNodeNames={selectedNodeNames}
              selectedEdge={selectedEdge}
              editingNodeName={editingNodeName}
              highlightedNodeName={highlightedNodeName}
              showLabels={showLabels}
              gridSize={gridSize}
              gridSnap={gridSnap}
              placementMode={placementMode}
              edgeMode={edgeMode}
              edgeSource={edgeSource}
              traceMode={traceMode}
              traceSummary={traceSummary}
              onNodeSelect={(name, addToSelection) => {
                if (edgeMode && name !== null) {
                  // Edge-mode state machine — see src/utils/edgeMode.ts
                  const step = nextEdgeStep(edgeSource, name);
                  switch (step.kind) {
                    case "pickSource":
                      setEdgeSource(step.source);
                      break;
                    case "cancelSource":
                      setEdgeSource(null);
                      break;
                    case "connect":
                      pywrJson.addEdge(step.from, step.to);
                      setEdgeMode(false);
                      setEdgeSource(null);
                      break;
                  }
                  return;
                }
                // Selecting any node clears edge selection (single-thing-selected rule)
                setSelectedEdge(null);
                if (name === null) {
                  setSelectedNodeName(null);
                  setSelectedNodeNames([]);
                } else if (addToSelection) {
                  setSelectedNodeNames(prev =>
                    prev.includes(name) ? prev.filter(n => n !== name) : [...prev, name]
                  );
                  setSelectedNodeName(name);
                } else {
                  setSelectedNodeName(name);
                  setSelectedNodeNames([name]);
                }
              }}
              onEdgeSelect={(edge) => {
                // Selecting an edge clears node selection (single-thing-selected rule).
                if (edge) { setSelectedNodeName(null); setSelectedNodeNames([]); }
                setSelectedEdge(edge);
              }}
              onTraceModeChange={setTraceMode}
              onNodeMove={(name, x, y) => { layout.setPosition(name, x, y); pywrJson.markDirty(); }}
              onDeleteRequest={setDeleteTarget}
              onDeleteMultiple={setBatchDeleteTargets}
              onDeleteEdgeRequest={(from, to) => setDeleteEdgeTarget({ from, to })}
              onRenameRequest={(name) => { setSelectedNodeName(name); setSelectedNodeNames([name]); setEditingNodeName(name); }}
              onRenameComplete={(oldName, newName) => { setEditingNodeName(null); if (newName && newName !== oldName) { pywrJson.renameNode(oldName, newName); layout.renamePosition(oldName, newName); setSelectedNodeName(newName); setSelectedNodeNames([newName]); } }}
              onAddNode={handleAddNode}
              onConnect={handleConnect}
              onPlacementClick={(flowX, flowY, screenX, screenY) => {
                if (!pywrJson.model) return;
                const existingNames = new Set(pywrJson.model.nodes.map(n => n.name));
                let i = 1;
                let defaultName = `Node_${i}`;
                while (existingNames.has(defaultName)) { i++; defaultName = `Node_${i}`; }
                setPlacementData({ flowX, flowY, screenX, screenY, defaultName });
                setPlacementMode(false);
              }}
            />
            {pywrJson.model && (
              <RecorderManager
                model={pywrJson.model}
                selectedNodeNames={selectedNodeNames}
                onApply={(updatedModel) => pywrJson.replaceModel(updatedModel)}
              />
            )}
            {selectedNode && (
              <PropertiesPanel
                node={selectedNode}
                onUpdate={(updates) => pywrJson.updateNode(selectedNode.name, updates)}
                onRename={(newName) => {
                  const oldName = selectedNode.name;
                  pywrJson.renameNode(oldName, newName);
                  layout.renamePosition(oldName, newName);
                  setSelectedNodeName(newName);
                  setSelectedNodeNames([newName]);
                }}
                onLinkCsv={handleLinkCsv}
              />
            )}
          </div>

          {/* JSON panel — kept in DOM once model loads (preserves editor state) */}
          {pywrJson.model && (
            <div style={{
              position: "absolute", inset: 0,
              display: activeTab === "json" ? "flex" : "none",
              flexDirection: "column",
              overflow: "hidden",
            }}>
              <JsonEditor
                model={pywrJson.model}
                onApply={handleJsonApply}
              />
            </div>
          )}

          {/* Map panel — third top-level view. Drag-to-move nodes write back
              through the same layout state the Canvas tab uses, so the layout
              → model effect (above) keeps the JSON tab honest. Run controls
              live in-panel so a user staying on this tab can run Pywr without
              hopping back to the toolbar. */}
          {pywrJson.model && (
            <div style={{
              position: "absolute", inset: 0,
              display: activeTab === "map" ? "flex" : "none",
              overflow: "hidden",
            }}>
              <MapView
                model={pywrJson.model}
                positions={layout.positions}
                backgroundImage={layout.backgroundImage}
                backgroundOpacity={layout.backgroundOpacity}
                onNodeMove={(name, x, y) => { layout.setPosition(name, x, y); pywrJson.markDirty(); }}
                selectedNodeName={selectedNodeName}
                onSelectNode={(name) => {
                  setSelectedNodeName(name);
                  setSelectedNodeNames(name ? [name] : []);
                }}
                activeFlowEdges={activeFlowEdges}
                runState={run.state}
                runDisabledReason={
                  !pywrJson.model
                    ? "Open or create a model first"
                    : !pywrJson.currentPath
                      ? "Save the model to a file before running"
                      : pywrJson.hasRunBlockingChanges
                        ? "Save your changes before running"
                        : run.state.status === "running" || run.state.status === "starting"
                          ? "A run is already in progress"
                          : null
                }
                onRun={startRun}
                onCancelRun={run.cancel}
                onOpenResults={(initialPath) => setResultsViewerPath(initialPath ?? "")}
              />
            </div>
          )}

          {/* Results panel — clicking a node traces forward edges to find every
              reachable Output sink and pairs it with the recorder values from
              the most recent run's summary.json. Selection is shared with the
              rest of the app so clicking here also highlights the node on the
              Canvas/Map tabs. */}
          {pywrJson.model && (
            <div style={{
              position: "absolute", inset: 0,
              display: activeTab === "results" ? "flex" : "none",
              overflow: "hidden",
            }}>
              <ResultsTab
                model={pywrJson.model}
                runState={run.state}
                runResults={runResults}
                selectedNodeName={selectedNodeName}
                onSelectNode={(name) => {
                  setSelectedNodeName(name);
                  setSelectedNodeNames([name]);
                }}
              />
            </div>
          )}

          {/* History panel */}
          <div style={{
            position: "absolute", inset: 0,
            display: activeTab === "history" ? "flex" : "none",
            flexDirection: "column",
            overflow: "hidden",
          }}>
            <HistoryPanel entries={pywrJson.historyLog} />
          </div>

        </div>

        {/* Validation bar — only shown on canvas tab, sits below the panels */}
        {activeTab === "canvas" && (
          <ValidationBar
            model={pywrJson.model}
            onNodeHighlight={handleNodeHighlight}
          />
        )}
      </div>

      {/* Add node modal */}
      {showAddNodeModal && (
        <AddNodeModal
          onAdd={handleAddNodeFromModal}
          onClose={() => setShowAddNodeModal(false)}
        />
      )}

      {/* Node placement popup — appears after clicking canvas in placement mode */}
      {placementData && (
        <NodePlacementPopup
          screenX={placementData.screenX}
          screenY={placementData.screenY}
          defaultName={placementData.defaultName}
          onConfirm={(name, nodeType) => {
            if (!pywrJson.model) return;
            const { node } = createNodeFromDrop(nodeType, placementData.flowX, placementData.flowY, new Set(pywrJson.model.nodes.map(n => n.name)));
            const namedNode = { ...node, name: name || node.name };
            pywrJson.addNode(namedNode);
            layout.setPosition(namedNode.name, placementData.flowX, placementData.flowY);
            setPlacementData(null);
          }}
          onCancel={() => setPlacementData(null)}
        />
      )}

      {/* Save before close dialog */}
      {showCloseDialog && (
        <SaveBeforeCloseDialog
          currentPath={pywrJson.currentPath}
          onSave={async (proposed) => {
            const saved = await performSave(proposed);
            if (saved) {
              setShowCloseDialog(false);
              doClose();
            }
            return saved;
          }}
          onDiscard={() => {
            setShowCloseDialog(false);
            doClose();
          }}
          onCancel={() => setShowCloseDialog(false)}
        />
      )}

      {/* Delete dialog (modal) */}
      {deleteTarget && pywrJson.model && (
        <DeleteNodeDialog
          nodeName={deleteTarget}
          model={pywrJson.model}
          getOrphanedNodes={pywrJson.getOrphanedNodes}
          removeNode={pywrJson.removeNode}
          addEdge={pywrJson.addEdge}
          onClose={() => {
            setDeleteTarget(null);
            setSelectedNodeName(null);
            setSelectedNodeNames([]);
          }}
        />
      )}

      {/* Delete edge confirmation */}
      {deleteEdgeTarget && (
        <DeleteEdgeDialog
          from={deleteEdgeTarget.from}
          to={deleteEdgeTarget.to}
          onConfirm={() => {
            pywrJson.removeEdge(deleteEdgeTarget.from, deleteEdgeTarget.to);
            setDeleteEdgeTarget(null);
            setSelectedEdge(null);
          }}
          onCancel={() => setDeleteEdgeTarget(null)}
        />
      )}

      {/* Batch delete confirm dialog */}
      {batchDeleteTargets.length > 1 && pywrJson.model && (
        <div style={{ position: "fixed", inset: 0, backgroundColor: "rgba(0,0,0,0.4)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000 }}
          onClick={() => setBatchDeleteTargets([])}>
          <div style={{ backgroundColor: "#fff", borderRadius: 8, padding: 24, minWidth: 360, maxWidth: 480, boxShadow: "0 4px 24px rgba(0,0,0,0.18)", fontFamily: "sans-serif" }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "#c0392b" }}>
              Delete {batchDeleteTargets.length} nodes?
            </h3>
            <p style={{ fontSize: 13, color: "#444", margin: "0 0 8px 0" }}>
              The following nodes and all their connections will be removed:
            </p>
            <ul style={{ fontSize: 12, color: "#555", margin: "0 0 16px 0", paddingLeft: 18 }}>
              {batchDeleteTargets.map(n => <li key={n}>{n}</li>)}
            </ul>
            <p style={{ fontSize: 12, color: "#888", margin: "0 0 20px 0" }}>Use ⌘Z to undo (one press per node).</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button style={{ padding: "6px 14px", border: "1px solid #ccc", borderRadius: 4, backgroundColor: "#fff", cursor: "pointer", fontSize: 12 }}
                onClick={() => setBatchDeleteTargets([])}>Cancel</button>
              <button style={{ padding: "6px 14px", border: "none", borderRadius: 4, backgroundColor: "#c0392b", color: "#fff", cursor: "pointer", fontSize: 12, fontWeight: "bold" }}
                onClick={() => {
                  // Cascade-removal lives in pywrJson.removeNode — each call drops
                  // touching edges, dependent recorders, and node-array references.
                  for (const name of batchDeleteTargets) {
                    pywrJson.removeNode(name);
                  }
                  setBatchDeleteTargets([]);
                  setSelectedNodeName(null);
                  setSelectedNodeNames([]);
                }}>
                Confirm Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Search overlay */}
      {showSearch && pywrJson.model && (
        <SearchOverlay
          model={pywrJson.model}
          onSelect={(name) => {
            setSelectedNodeName(name);
            setSelectedNodeNames([name]);
            canvasRef.current?.zoomToNodes([name]);
          }}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Loading / error overlays */}
      {pywrJson.isLoading && (
        <div style={overlayStyle}>
          <span style={{ color: "#fff", fontSize: 14 }}>Loading model…</span>
        </div>
      )}

      {(pywrJson.error || saveError) && (
        <div
          style={{
            position: "fixed",
            bottom: 44,
            left: "50%",
            transform: "translateX(-50%)",
            backgroundColor: "#c0392b",
            color: "#fff",
            padding: "8px 16px",
            borderRadius: 6,
            fontSize: 12,
            zIndex: 500,
            maxWidth: 500,
            textAlign: "center",
          }}
          onClick={() => setSaveError(null)}
        >
          {pywrJson.error ?? saveError}
        </div>
      )}

      {/* Run panel — only present when a run is active or just-finished. */}
      {showRunPanel && run.state.status !== "idle" && (
        <RunPanel
          state={run.state}
          onCancel={run.cancel}
          onClose={() => setShowRunPanel(false)}
        />
      )}

      {/* Results viewer — opens on demand from the Map tab. Modal, so it
          overlays whatever tab the user happened to be on. */}
      {resultsViewerPath !== null && (
        <ResultsViewer
          initialPath={resultsViewerPath || null}
          onClose={() => setResultsViewerPath(null)}
        />
      )}

      {/* Status bar — always at the very bottom */}
      <StatusBar
        model={pywrJson.model}
        currentPath={pywrJson.currentPath}
        isDirty={pywrJson.isDirty}
        runDisabledReason={
          !pywrJson.model
            ? "Open or create a model first"
            : !pywrJson.currentPath
              ? "Save the model to a file before running"
              : pywrJson.hasRunBlockingChanges
                ? "Save model changes before running"
                : run.state.status === "running" || run.state.status === "starting"
                  ? "Run in progress"
                  : null
        }
        selectedCount={selectedNodeNames.length}
      />
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 900,
};

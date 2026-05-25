// src/hooks/usePywrJson.ts
// Manages the loaded Pywr model in React state.
// All API calls go through window.pywr.callApi — no direct fetch().

import { useState, useCallback, useRef, useEffect } from "react";
import {
  PywrModel,
  PywrNode,
  PywrEdge,
  PywrRunEvent,
  PywrRunHandle,
  CheckPythonResult,
} from "../types/pywr";
import {
  scrubNodeRefs,
  filterEdgesForNode,
  filterRecordersForNode,
} from "../utils/cascadeDelete";
import { embedNodePosition } from "../utils/nodePosition";

// window.pywr is exposed by tauri_bridge.ts at startup. Comment used to claim
// "electron/preload.js via contextBridge" — that's been replaced by Tauri's
// invoke()-based bridge; keeping the global shape makes the migration
// transparent to every consumer.
declare global {
  interface Window {
    pywr: {
      openFile: () => Promise<string | null>;
      openImage: () => Promise<string | null>;
      saveFile: (defaultPath: string) => Promise<string | null>;
      callApi: (route: string, body: unknown) => Promise<unknown>;
      saveLayoutFile: (path: string, content: string) => Promise<void>;
      readLayoutFile: (path: string) => Promise<string | null>;
      openCsv: () => Promise<string | null>;
      readCsvColumns: (path: string) => Promise<string[]>;
      // Results-file picker — same shape as openCsv but accepts both CSV and HDF5.
      openResults: () => Promise<string | null>;
      // CSV table preview: headers + first `maxRows` data rows, plus total_rows
      // so the UI can show "showing N of M". `error` is set when ok=false; the
      // caller never has to throw — failures are reported in-band.
      readCsvPreview: (path: string, maxRows: number) => Promise<{
        ok: boolean;
        headers: string[];
        rows: string[][];
        total_rows: number;
        returned_rows: number;
        error: string | null;
      }>;
      // HDF5 dataset list — flat array of {name, shape, dtype, size}. The
      // shape of failure is the same {ok, error} envelope to keep one parser.
      readH5List: (path: string) => Promise<{
        ok: boolean;
        datasets?: { name: string; shape: number[]; dtype: string; size: number }[];
        error?: string;
      }>;
      // HDF5 dataset preview — same envelope shape as readCsvPreview so the
      // UI table renderer doesn't need to special-case the source format.
      readH5Preview: (path: string, dataset: string, maxRows: number) => Promise<{
        ok: boolean;
        headers?: string[];
        rows?: (string | number)[][];
        shape?: number[];
        total_rows?: number;
        returned_rows?: number;
        error?: string;
      }>;
      runModel: (jsonPath: string, outDir: string) => Promise<PywrRunHandle>;
      onRunEvent: (
        eventName: string,
        handler: (event: PywrRunEvent) => void,
      ) => Promise<() => void>;
      cancelRun: (runId: string) => Promise<void>;
      checkPython: () => Promise<CheckPythonResult>;
      quit: () => Promise<void>;
    };
  }
}

export interface HistoryEntry {
  label: string;
  timestamp: Date;
}

interface UsePywrJsonReturn {
  model: PywrModel | null;
  currentPath: string | null;
  isLoading: boolean;
  error: string | null;
  newModel: () => void;
  openFile: () => Promise<void>;
  loadAtPath: (path: string, model: PywrModel) => void;
  replaceModel: (model: PywrModel) => void;
  addNode: (node: PywrNode) => void;
  removeNode: (nodeName: string) => void;
  updateNode: (nodeName: string, updates: Partial<PywrNode>) => void;
  renameNode: (oldName: string, newName: string) => void;
  addEdge: (from: string, to: string) => void;
  removeEdge: (from: string, to: string) => void;
  // Position mutators — write position.editor_position + position.schematic onto
  // the named node(s). No history push: layout.* owns position undo/redo, and
  // drag-stop fires too often for a per-pixel model history. No-op when the
  // values are already what's stored (keeps React renders stable).
  updateNodePosition: (name: string, x: number, y: number) => void;
  updateNodePositions: (positions: Record<string, { x: number; y: number }>) => void;
  addParameter: (name: string, def: unknown) => void;
  removeParameter: (name: string) => void;
  getNodeByName: (name: string) => PywrNode | undefined;
  getEdgesForNode: (name: string) => Array<[string, string]>;
  getOrphanedNodes: (removedName: string) => { upstream: string[]; downstream: string[] };
  isDirty: boolean;
  hasRunBlockingChanges: boolean;
  markSaved: () => void;
  markDirty: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  historyLog: HistoryEntry[];
}

interface UsePywrJsonOptions {
  onPushHistory?: () => void;
  onClearHistory?: () => void;
}

export function usePywrJson(options?: UsePywrJsonOptions): UsePywrJsonReturn {
  const [model, setModel] = useState<PywrModel | null>(null);
  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const [hasRunBlockingChanges, setHasRunBlockingChanges] = useState(false);

  // Undo/redo history — store up to 50 snapshots
  const [past, setPast] = useState<PywrModel[]>([]);
  const [future, setFuture] = useState<PywrModel[]>([]);
  // Change log — human-readable list of actions
  const [historyLog, setHistoryLog] = useState<HistoryEntry[]>([]);
  // Keep a ref so pushToHistory always captures the latest model
  const modelRef = useRef<PywrModel | null>(null);
  useEffect(() => { modelRef.current = model; }, [model]);

  // Keep options ref so callbacks are always current without being in dep arrays
  const optionsRef = useRef(options);
  useEffect(() => { optionsRef.current = options; }, [options]);

  const pushToHistory = useCallback((label: string) => {
    if (!modelRef.current) return;
    const snapshot = modelRef.current;
    setPast((prev) => [...prev.slice(-49), snapshot]);
    setFuture([]);
    setHistoryLog((prev) => [{ label, timestamp: new Date() }, ...prev.slice(0, 199)]);
    optionsRef.current?.onPushHistory?.();
  }, []);

  // -------------------------------------------------------------------------
  // newModel — creates an empty Pywr model (no file on disk yet)
  // -------------------------------------------------------------------------
  const newModel = useCallback(() => {
    const blank: PywrModel = {
      metadata: { title: "New Model", description: "", minimum_version: "1.0" },
      timestepper: { start: "2015-01-01", end: "2015-12-31", timestep: 1 },
      nodes: [],
      edges: [],
      parameters: {},
      recorders: {},
    };
    setModel(blank);
    setCurrentPath(null);
    setPast([]);
    setFuture([]);
    setHistoryLog([{ label: "New model created", timestamp: new Date() }]);
    setIsDirty(false);
    setHasRunBlockingChanges(false);
    optionsRef.current?.onClearHistory?.();
  }, []);

  // -------------------------------------------------------------------------
  // openFile — calls window.pywr.openFile() then POST /api/parse
  // -------------------------------------------------------------------------
  const openFile = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const path = await window.pywr.openFile();
      if (!path) {
        // User cancelled the file picker
        return;
      }
      setCurrentPath(path);

      const response = await window.pywr.callApi("/api/parse", { json_path: path });
      const resp = response as { ok: boolean; data?: PywrModel; error?: string };

      if (!resp.ok) {
        setError(resp.error ?? "Failed to parse model");
        return;
      }

      setModel(resp.data ?? null);
      setPast([]);
      setFuture([]);
      setHistoryLog([{ label: `Opened ${path.split(/[\\/]/).pop()}`, timestamp: new Date() }]);
      setIsDirty(false);
      setHasRunBlockingChanges(false);
      optionsRef.current?.onClearHistory?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error opening file");
    } finally {
      setIsLoading(false);
    }
  }, []);

  // -------------------------------------------------------------------------
  // loadAtPath — load a model from a specific path (used by recent files)
  // -------------------------------------------------------------------------
  const loadAtPath = useCallback((path: string, newModel: PywrModel) => {
    setModel(newModel);
    setCurrentPath(path);
    setPast([]);
    setFuture([]);
    setHistoryLog([{ label: `Opened ${path.split(/[\\/]/).pop()}`, timestamp: new Date() }]);
    setIsDirty(false);
    setHasRunBlockingChanges(false);
    optionsRef.current?.onClearHistory?.();
  }, []);

  // -------------------------------------------------------------------------
  // replaceModel — swap the entire model (used by JSON editor tab)
  // -------------------------------------------------------------------------
  const replaceModel = useCallback((newModel: PywrModel) => {
    pushToHistory("Edit JSON");
    setModel(newModel);
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // undo / redo
  // -------------------------------------------------------------------------
  const undo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[prev.length - 1];
      const newPast = prev.slice(0, -1);
      setFuture((f) => (modelRef.current ? [modelRef.current, ...f.slice(0, 49)] : f));
      setModel(restored);
      setIsDirty(true);
      setHasRunBlockingChanges(true);
      setHistoryLog((log) => [{ label: "Undo", timestamp: new Date() }, ...log.slice(0, 199)]);
      return newPast;
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const restored = prev[0];
      const newFuture = prev.slice(1);
      setPast((p) => (modelRef.current ? [...p.slice(-49), modelRef.current] : p));
      setModel(restored);
      setIsDirty(true);
      setHasRunBlockingChanges(true);
      setHistoryLog((log) => [{ label: "Redo", timestamp: new Date() }, ...log.slice(0, 199)]);
      return newFuture;
    });
  }, []);

  // -------------------------------------------------------------------------
  // addNode — immutable insert
  // -------------------------------------------------------------------------
  const addNode = useCallback((node: PywrNode) => {
    pushToHistory(`Add node "${node.name}" (${node.type})`);
    setModel((prev) => {
      if (!prev) return prev;
      return { ...prev, nodes: [...prev.nodes, node] };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // removeNode — cascade-removes the node and every reference to it.
  // Atomic (one history entry, one undo step). The cascade includes:
  //   - the node itself
  //   - all edges that touch it (from_node or to_node)
  //   - the deleted name stripped from any nodes/storages arrays on remaining nodes
  //     (VirtualStorage, AggregatedNode, AggregatedStorage, etc.)
  //   - recorders whose `node` field equals the deleted name
  // Parameters are intentionally left untouched (DECISIONS.md D-06); validation
  // surfaces dangling refs as warnings.
  // -------------------------------------------------------------------------
  const removeNode = useCallback((nodeName: string) => {
    pushToHistory(`Delete node "${nodeName}"`);
    setModel((prev) => {
      if (!prev) return prev;
      const nodes = prev.nodes
        .filter((n) => n.name !== nodeName)
        .map((n) => scrubNodeRefs(n, nodeName));
      const edges = filterEdgesForNode(prev.edges, nodeName);
      const recorders = filterRecordersForNode(prev.recorders, nodeName);
      return { ...prev, nodes, edges, recorders };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // updateNode — merges updates into the matching node
  // -------------------------------------------------------------------------
  const updateNode = useCallback((nodeName: string, updates: Partial<PywrNode>) => {
    const fields = Object.keys(updates).join(", ");
    pushToHistory(`Edit "${nodeName}": ${fields}`);
    setModel((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map((n) =>
          n.name === nodeName ? ({ ...n, ...updates } as PywrNode) : n
        ),
      };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // addEdge — immutable insert
  // -------------------------------------------------------------------------
  const addEdge = useCallback((from: string, to: string) => {
    pushToHistory(`Add edge "${from}" → "${to}"`);
    setModel((prev) => {
      if (!prev) return prev;
      const edge: PywrEdge = [from, to];
      return { ...prev, edges: [...prev.edges, edge] };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // removeEdge — removes the first edge matching from→to
  // -------------------------------------------------------------------------
  const removeEdge = useCallback((from: string, to: string) => {
    pushToHistory(`Delete edge "${from}" → "${to}"`);
    setModel((prev) => {
      if (!prev) return prev;
      let removed = false;
      const edges = prev.edges.filter((e) => {
        if (!removed && e[0] === from && e[1] === to) {
          removed = true;
          return false;
        }
        return true;
      });
      return { ...prev, edges };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // updateNodePosition / updateNodePositions — write position fields on nodes.
  // The actual position merge lives in utils/nodePosition.embedNodePosition,
  // which writes both editor_position (pywr-editor) and schematic (Pywr core /
  // Viewer) with the same [x, y] and preserves existing keys (e.g. geographic).
  //
  // No history push: layout.* owns position undo/redo via its own snapshot
  // history; drag-stop fires too often to be useful as a model-history step.
  //
  // Returns prev unchanged when nothing actually moved — React skips the
  // re-render, breaking any potential ping-pong between layout↔model sync.
  // embedNodePosition returns the same reference when the coords already
  // match, so we use that identity to detect "nothing changed".
  // -------------------------------------------------------------------------
  const updateNodePositions = useCallback(
    (positions: Record<string, { x: number; y: number }>) => {
      // Compute "will this change anything?" synchronously from modelRef.
      // React 18 batches state updates, so we can't observe the result of
      // setModel's updater before this function returns — the only safe
      // way to gate setIsDirty(true) is to check the current model now.
      const cur = modelRef.current;
      if (!cur) return;
      const willChange = cur.nodes.some((node) => {
        const p = positions[node.name];
        if (!p) return false;
        return embedNodePosition(node, p.x, p.y) !== node;
      });
      if (!willChange) return; // identical to current state — no React render

      setModel((prev) => {
        if (!prev) return prev;
        const nodes = prev.nodes.map((node) => {
          const p = positions[node.name];
          if (!p) return node;
          return embedNodePosition(node, p.x, p.y);
        });
        return { ...prev, nodes };
      });
      setIsDirty(true);
    },
    [],
  );

  const updateNodePosition = useCallback(
    (name: string, x: number, y: number) => {
      updateNodePositions({ [name]: { x, y } });
    },
    [updateNodePositions],
  );

  // -------------------------------------------------------------------------
  // renameNode — renames a node and updates all edge references
  // -------------------------------------------------------------------------
  const renameNode = useCallback((oldName: string, newName: string) => {
    if (!newName.trim() || newName === oldName) return;
    pushToHistory(`Rename "${oldName}" → "${newName}"`);
    setModel((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        nodes: prev.nodes.map((n) => n.name === oldName ? { ...n, name: newName } : n),
        edges: prev.edges.map((e) => {
          // Preserve any slot args (positions 2+) when renaming endpoints
          const renamed = e.map((v, i) =>
            i < 2 && v === oldName ? newName : v,
          ) as unknown as PywrEdge;
          return renamed;
        }),
      };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, [pushToHistory]);

  // -------------------------------------------------------------------------
  // addParameter / removeParameter — manage model.parameters entries
  // -------------------------------------------------------------------------
  const addParameter = useCallback((name: string, def: unknown) => {
    setModel((prev) => {
      if (!prev) return prev;
      return { ...prev, parameters: { ...prev.parameters, [name]: def } };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, []);

  const removeParameter = useCallback((name: string) => {
    setModel((prev) => {
      if (!prev) return prev;
      const { [name]: _removed, ...rest } = prev.parameters;
      return { ...prev, parameters: rest };
    });
    setIsDirty(true);
    setHasRunBlockingChanges(true);
  }, []);

  // -------------------------------------------------------------------------
  // getNodeByName — pure query, no state mutation
  // -------------------------------------------------------------------------
  const getNodeByName = useCallback(
    (name: string): PywrNode | undefined => {
      return model?.nodes.find((n) => n.name === name);
    },
    [model]
  );

  // -------------------------------------------------------------------------
  // getEdgesForNode — returns all edges where node is from or to
  // -------------------------------------------------------------------------
  const getEdgesForNode = useCallback(
    (name: string): Array<[string, string]> => {
      if (!model) return [];
      return model.edges
        .filter((e) => e[0] === name || e[1] === name)
        .map((e) => [e[0], e[1]]);
    },
    [model]
  );

  // -------------------------------------------------------------------------
  // getOrphanedNodes — pure query
  // Returns nodes that would become unreachable if removedName were deleted.
  // upstream:   nodes that only connect downstream through removedName
  // downstream: nodes that only connect upstream through removedName
  //
  // Definition used here:
  //   upstream   = nodes that have an edge TO removedName (they feed it)
  //   downstream = nodes that have an edge FROM removedName (it feeds them)
  // -------------------------------------------------------------------------
  const getOrphanedNodes = useCallback(
    (removedName: string): { upstream: string[]; downstream: string[] } => {
      if (!model) return { upstream: [], downstream: [] };

      const { nodes, edges } = model;

      // Nodes that feed into removedName
      const directUpstream = edges
        .filter((e) => e[1] === removedName)
        .map((e) => e[0]);

      // Nodes that removedName feeds into
      const directDownstream = edges
        .filter((e) => e[0] === removedName)
        .map((e) => e[1]);

      // Build edge map without removedName to check for alternative connections
      const remainingEdges = edges.filter(
        (e) => e[0] !== removedName && e[1] !== removedName,
      );
      const remainingNodeNames = new Set(
        nodes.filter((n) => n.name !== removedName).map((n) => n.name)
      );

      // A node is "orphaned upstream" if after removing removedName it has no
      // outgoing edges at all (it was only feeding removedName)
      const orphanedUpstream = directUpstream.filter((upName) => {
        const hasOtherOutgoing = remainingEdges.some(
          (e) => e[0] === upName && remainingNodeNames.has(e[1]),
        );
        return !hasOtherOutgoing;
      });

      // A node is "orphaned downstream" if after removing removedName it has no
      // incoming edges at all (it was only being fed by removedName)
      const orphanedDownstream = directDownstream.filter((downName) => {
        const hasOtherIncoming = remainingEdges.some(
          (e) => e[1] === downName && remainingNodeNames.has(e[0]),
        );
        return !hasOtherIncoming;
      });

      return {
        upstream: orphanedUpstream,
        downstream: orphanedDownstream,
      };
    },
    [model]
  );

  // -------------------------------------------------------------------------
  // markSaved — resets dirty flags (called by export flow)
  // -------------------------------------------------------------------------
  const markSaved = useCallback(() => {
    setIsDirty(false);
    setHasRunBlockingChanges(false);
  }, []);
  const markDirty = useCallback(() => { setIsDirty(true); }, []);

  return {
    model,
    currentPath,
    isLoading,
    error,
    newModel,
    openFile,
    loadAtPath,
    replaceModel,
    addNode,
    removeNode,
    updateNode,
    renameNode,
    addEdge,
    removeEdge,
    updateNodePosition,
    updateNodePositions,
    addParameter,
    removeParameter,
    getNodeByName,
    getEdgesForNode,
    getOrphanedNodes,
    isDirty,
    hasRunBlockingChanges,
    markSaved,
    markDirty,
    undo,
    redo,
    canUndo: past.length > 0,
    canRedo: future.length > 0,
    historyLog,
  };
}

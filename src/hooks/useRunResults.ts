// src/hooks/useRunResults.ts
// Owns the post-run data loaded from <outDir>/summary.json and the derived
// "which nodes carry flow" view.
//
// Why a hook: both the Results tab and the Canvas / Map need this same data
// to render flow-aware UI (the tab shows aggregate values; the canvas paints
// active edges in green). Pulling it into one hook keeps the parse/typing
// rules in one place — drift between two ad-hoc loaders is exactly the kind
// of thing that produces subtle "edge says active, panel says zero" bugs.

import { useEffect, useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import type { RunStateView } from "./useModelRun";
import { normalizeNodeType } from "../constants/nodeTypes";

// Non-zero threshold — recorded values smaller than this are treated as 0 to
// shake off floating-point noise. Matches the threshold used in ResultsTab.
export const ACTIVE_EPS = 1e-9;

export interface RunResultsView {
  // Per-recorder aggregate flow values, keyed by recorder name. null until a
  // run completes (or summary.json is unreadable).
  recAgg: Record<string, number> | null;
  // Aggregated per-node total (sum of every recorder bound to the node).
  // Empty when no run data is loaded.
  nodeFlow: Map<string, number>;
  // Convenience: node names with |totalFlow| > ACTIVE_EPS. Same content as
  // filtering nodeFlow, but computing it once is cheaper than every consumer
  // re-deriving it.
  activeNodes: Set<string>;
  // Surfaced for UI hints; null means "no error so far".
  error: string | null;
}

const EMPTY: RunResultsView = {
  recAgg: null,
  nodeFlow: new Map(),
  activeNodes: new Set(),
  error: null,
};

export function useRunResults(
  model: PywrModel | null,
  runState: RunStateView,
): RunResultsView {
  const [recAgg, setRecAgg] = useState<Record<string, number> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // A fresh run starts: clear stale data so the canvas doesn't keep painting
    // edges as active while the new run is mid-flight.
    if (runState.status !== "done") {
      setRecAgg(null);
      setError(null);
      return;
    }
    const summary = runState.outputs.find((o) => o.name === "summary");
    if (!summary) return;

    let cancelled = false;
    (async () => {
      try {
        const content = await window.pywr.readLayoutFile(summary.path);
        if (cancelled) return;
        if (!content) {
          setError(`summary.json not readable at ${summary.path}`);
          return;
        }
        const parsed = JSON.parse(content);
        const recs = parsed?.recorders;
        if (!recs || typeof recs !== "object") {
          setError("summary.json is missing the 'recorders' section.");
          return;
        }
        const numeric: Record<string, number> = {};
        for (const [k, v] of Object.entries(recs)) {
          if (typeof v === "number" && Number.isFinite(v)) numeric[k] = v;
        }
        setRecAgg(numeric);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => { cancelled = true; };
  }, [runState.status, runState.outputs]);

  // Build the node-flow map: walk the model's recorders, pair each with its
  // bound node, and sum aggregate values. Storage-style recorders contribute
  // to the same map — for the purpose of "is this node active?", any non-zero
  // recorded quantity counts.
  return useMemo<RunResultsView>(() => {
    if (!model || !recAgg) {
      return { ...EMPTY, recAgg, error };
    }
    const nodeFlow = new Map<string, number>();
    for (const [recName, raw] of Object.entries(model.recorders ?? {})) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const node = typeof r.node === "string" ? r.node : null;
      if (!node) continue;
      const v = recAgg[recName];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      nodeFlow.set(node, (nodeFlow.get(node) ?? 0) + v);
    }
    const activeNodes = new Set<string>();
    for (const [name, v] of nodeFlow) {
      if (Math.abs(v) > ACTIVE_EPS) activeNodes.add(name);
    }
    return { recAgg, nodeFlow, activeNodes, error };
  }, [model, recAgg, error]);
}

// -----------------------------------------------------------------------------
// activeFlowEdges — pure function (exported for tests)
//
// Returns the set of edges (as "from->to" strings) that lie on some path from
// `source` to an Output-type sink with non-zero recorded flow. We require
// both endpoints of every returned edge to lie on such a path so we never
// highlight an edge that "dead-ends" into an inactive branch — that would
// mis-imply flow where there is none.
// -----------------------------------------------------------------------------
export function activeFlowEdges(
  model: PywrModel,
  source: string,
  activeNodes: Set<string>,
): Set<string> {
  // 1. Forward reachable subgraph from `source`.
  const fwd = new Map<string, string[]>();
  const rev = new Map<string, string[]>();
  for (const e of model.edges) {
    const u = e[0];
    const v = e[1];
    if (!fwd.has(u)) fwd.set(u, []);
    fwd.get(u)!.push(v);
    if (!rev.has(v)) rev.set(v, []);
    rev.get(v)!.push(u);
  }

  const reachable = new Set<string>([source]);
  const queue: string[] = [source];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of fwd.get(cur) ?? []) {
      if (!reachable.has(next)) {
        reachable.add(next);
        queue.push(next);
      }
    }
  }

  // 2. Active sinks = reachable Output-type nodes with non-zero recorded flow.
  // Pywr accepts mixed-case node types in JSON ("output", "Output", "OUTPUT"
  // are all valid). normalizeNodeType maps any variant to the canonical
  // PascalCase form so the comparison works against real-world models.
  const activeSinks: string[] = [];
  for (const n of model.nodes) {
    if (normalizeNodeType(n.type) !== "Output") continue;
    if (!reachable.has(n.name)) continue;
    if (activeNodes.has(n.name)) activeSinks.push(n.name);
  }
  if (activeSinks.length === 0) return new Set();

  // 3. Reverse-BFS from active sinks, restricted to reachable nodes, to find
  //    every node that lies on some path source → active sink.
  const onActivePath = new Set<string>(activeSinks);
  const rq: string[] = [...activeSinks];
  while (rq.length > 0) {
    const cur = rq.shift()!;
    for (const pred of rev.get(cur) ?? []) {
      if (!reachable.has(pred)) continue;
      if (onActivePath.has(pred)) continue;
      onActivePath.add(pred);
      rq.push(pred);
    }
  }

  // 4. Edge (u, v) is "active" iff both endpoints lie on some source → active-sink
  //    path. The deduped string key matches the convention used by the canvas.
  const out = new Set<string>();
  for (const e of model.edges) {
    const u = e[0];
    const v = e[1];
    if (onActivePath.has(u) && onActivePath.has(v)) {
      out.add(`${u}->${v}`);
    }
  }
  return out;
}

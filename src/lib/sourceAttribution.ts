// src/lib/sourceAttribution.ts
// Pure helpers for the T3.10 node-pair source attribution view.
//
// Given a sink node S, attribute the recorded flow at S back to upstream
// source nodes (Input / Catchment / Discharge). The fraction returned for
// source X is "of every unit of flow recorded at S, what share came from X?".
//
// Why this matters: a downstream demand might be served by multiple sources
// in different proportions depending on cost structure, licence priority, and
// network shape. The reliability dashboard tells you *whether* demand was
// met; this view tells you *from where*. Useful for licence audits and
// drought-shift analysis (e.g. "demand A leans 90% on Catchment X — if X
// fails, A fails too").
//
// Algorithm — proportional flow attribution on a DAG:
//
//   claim(S)   = 1                                       (sink gets full claim)
//   claim(P)  += claim(N) × flow(P) / Σ_Q flow(Q)        (Q = parents of N
//                                                          with positive flow)
//
// Processed in reverse topological order from S. At each node N we split
// claim(N) across its parents proportionally to their *recorded node flow*.
//
// Approximation honesty: without edge-level flows (which T2.5 will provide),
// this is exact only if each parent's outflow is distributed across its
// children in the same ratio as the children's recorded inflows. For
// strictly tree-shaped sub-networks the approximation is exact; for general
// DAGs it's a best-available estimate. We surface that caveat to the user
// rather than pretending the numbers are bit-exact.
//
// Edge cases handled:
//   - Source node selected as the sink: returns a single 100% attribution
//     to itself.
//   - Sink has no upstream sources with recorded flow: returns an empty
//     result + an `unresolved` fraction explaining the gap.
//   - Cycles in the edge graph (Pywr models are usually acyclic but certain
//     link constructs can produce loops): Kahn's algorithm naturally skips
//     nodes inside a strongly-connected component because their
//     in-subgraph-children counters never reach zero. After the walk we
//     check whether any ancestor was left unprocessed and surface a
//     `cycleDetected` flag if so. The unresolved-fraction field absorbs
//     the claim stuck in the cycle.

import { normalizeNodeType } from "../constants/nodeTypes";
import type { PywrModel } from "../types/pywr";

// Minimum absolute recorded flow to treat a parent as a "real" contributor.
// Below this we treat the flow as zero. Same threshold ResultsTab uses for
// "active" — keeps the two views consistent so the canvas highlight and this
// panel agree on which edges carry flow.
export const ATTRIBUTION_EPS = 1e-9;

export type SourceRole = "input" | "catchment" | "discharge" | "other";

// One attributed source row. `fraction` is the share of the sink's recorded
// inflow that originated at this node. `contribution` is the absolute flow
// value (fraction × sink's aggregate). Both are aligned to the same `name`.
export interface AttributedSource {
  name: string;
  nodeType: string;
  role: SourceRole;
  fraction: number;
  contribution: number;
  // Total recorded flow at this node — context for the user. Useful for
  // distinguishing "tiny source carrying most of the burden" from "huge
  // source barely tapped".
  recordedFlow: number;
}

export interface SourceAttribution {
  // The sink node analysed.
  sinkName: string;
  // Aggregate recorded flow at the sink (sum of its node-bound recorders).
  // The contribution column is fraction × this number.
  sinkFlow: number;
  // Source rows, sorted descending by fraction.
  sources: AttributedSource[];
  // Unresolved share — fraction of the sink's claim that didn't reach any
  // source. Happens when (a) an ancestor branch has no recorded flow at all,
  // (b) the model has a cycle that swallowed the claim, or (c) the sink has
  // no upstream sources at all. Surfaced as a numeric so the UI can flag it
  // rather than silently letting the bars sum to less than 100%.
  unresolved: number;
  // True iff the iteration cap fired during the walk — flags a non-DAG
  // model where the attribution may be approximate.
  cycleDetected: boolean;
  // Human-readable explanation when the attribution couldn't be computed.
  // null on success.
  error: string | null;
}

function classifySource(nodeType: string): SourceRole {
  const t = normalizeNodeType(nodeType);
  if (t === "Input") return "input";
  if (t === "Catchment") return "catchment";
  if (t === "Discharge") return "discharge";
  return "other";
}

function isSourceType(nodeType: string): boolean {
  const role = classifySource(nodeType);
  return role !== "other";
}

// Build adjacency maps once. Returns:
//   parentsOf(name) → list of upstream node names
//   childrenOf(name) → list of downstream node names
function buildAdjacency(edges: PywrModel["edges"]): {
  parents: Map<string, string[]>;
  children: Map<string, string[]>;
} {
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  for (const e of edges) {
    const u = e[0];
    const v = e[1];
    if (!parents.has(v)) parents.set(v, []);
    parents.get(v)!.push(u);
    if (!children.has(u)) children.set(u, []);
    children.get(u)!.push(v);
  }
  return { parents, children };
}

// Pure: compute source attribution for one sink.
//
// Inputs:
//   - model       : the network. Used for nodes, edges, and type lookup.
//   - nodeFlow    : node-name → aggregate recorded flow. Same shape as
//                   useRunResults.nodeFlow. Nodes missing from the map are
//                   treated as having zero recorded flow (and therefore as
//                   non-contributing parents). This matches "we have no
//                   measurement here" rather than "we measured zero".
//   - sinkName    : the sink to attribute back from.
export function computeSourceAttribution(
  model: PywrModel,
  nodeFlow: Map<string, number>,
  sinkName: string,
): SourceAttribution {
  const empty: SourceAttribution = {
    sinkName,
    sinkFlow: nodeFlow.get(sinkName) ?? 0,
    sources: [],
    unresolved: 0,
    cycleDetected: false,
    error: null,
  };

  const sinkNode = model.nodes.find((n) => n.name === sinkName);
  if (!sinkNode) {
    return { ...empty, error: `Sink node "${sinkName}" not found in model.` };
  }

  // Self-attribution: the user picked a source as the sink. The "delivered
  // flow at this source" is, definitionally, 100% from itself.
  if (isSourceType(sinkNode.type)) {
    const flow = nodeFlow.get(sinkName) ?? 0;
    return {
      sinkName,
      sinkFlow: flow,
      sources: [
        {
          name: sinkName,
          nodeType: sinkNode.type,
          role: classifySource(sinkNode.type),
          fraction: 1,
          contribution: flow,
          recordedFlow: flow,
        },
      ],
      unresolved: 0,
      cycleDetected: false,
      error: null,
    };
  }

  const sinkFlow = nodeFlow.get(sinkName) ?? 0;
  if (sinkFlow <= ATTRIBUTION_EPS) {
    return {
      ...empty,
      error: `Sink "${sinkName}" has no recorded flow — nothing to attribute.`,
    };
  }

  const { parents } = buildAdjacency(model.edges);

  // Lookup: node-name → node type. Saves a model.nodes.find per visit.
  const typeOf = new Map<string, string>();
  for (const n of model.nodes) typeOf.set(n.name, n.type);

  // claim accumulator. Walk the DAG backwards in BFS layers; each layer
  // computes claim updates from the previous layer. We process one node at
  // a time using a queue ordered by "current claim is finalised" — for a
  // pure DAG, every node is processed exactly once because we wait for all
  // its descendants' claims to settle before propagating up.
  //
  // Settled order: a node is ready when every one of its children (in the
  // *attribution subgraph reaching the sink*) has been processed. We compute
  // the relevant subgraph first via a reverse BFS from the sink, then walk it
  // in reverse topological order.

  // Reverse-reachable set from sink. Restricts the walk to ancestors only.
  const ancestors = new Set<string>([sinkName]);
  {
    const q: string[] = [sinkName];
    while (q.length > 0) {
      const cur = q.shift()!;
      for (const p of parents.get(cur) ?? []) {
        if (!ancestors.has(p)) {
          ancestors.add(p);
          q.push(p);
        }
      }
    }
  }

  // Build per-ancestor child list restricted to the relevant subgraph. We
  // need this to know when a node is "ready" (all attribution-children
  // processed).
  const childrenInSubgraph = new Map<string, Set<string>>();
  for (const a of ancestors) childrenInSubgraph.set(a, new Set());
  for (const e of model.edges) {
    const u = e[0];
    const v = e[1];
    if (ancestors.has(u) && ancestors.has(v)) {
      childrenInSubgraph.get(u)!.add(v);
    }
  }

  // remainingChildren[N] = how many subgraph-children of N still need
  // processing before N is ready. When this hits 0, N is enqueued.
  const remainingChildren = new Map<string, number>();
  for (const [n, ch] of childrenInSubgraph) {
    remainingChildren.set(n, ch.size);
  }

  const claim = new Map<string, number>();
  claim.set(sinkName, 1);

  // Kahn-style reverse-topological walk. Seed with nodes whose subgraph-child
  // count is 0 — only the sink, since every other ancestor has at least one
  // path to the sink (otherwise it wouldn't be in `ancestors`).
  const ready: string[] = [];
  if ((remainingChildren.get(sinkName) ?? 0) === 0) ready.push(sinkName);

  const sources: Map<string, number> = new Map(); // name → accumulated fraction
  const processed = new Set<string>();

  while (ready.length > 0) {
    const n = ready.shift()!;
    processed.add(n);
    const nClaim = claim.get(n) ?? 0;
    const nType = typeOf.get(n) ?? "";

    if (isSourceType(nType)) {
      // Terminal in the attribution walk — accumulate. Don't propagate
      // further: a source's own claim is "I produced this flow".
      sources.set(n, (sources.get(n) ?? 0) + nClaim);
      continue;
    }

    // Distribute n's claim across its parents (in the subgraph) proportional
    // to their recorded flows. Parents with zero recorded flow are skipped —
    // attributing claim there would smear the result across branches that
    // demonstrably carried no water.
    const ps = (parents.get(n) ?? []).filter((p) => ancestors.has(p));
    let totalParentFlow = 0;
    for (const p of ps) {
      const f = nodeFlow.get(p) ?? 0;
      if (f > ATTRIBUTION_EPS) totalParentFlow += f;
    }

    if (totalParentFlow <= ATTRIBUTION_EPS) {
      // No parent has positive recorded flow. The claim has nowhere to go —
      // it stays as "unresolved". We don't propagate to zero-flow parents
      // because the model says they carried no water.
      continue;
    }

    for (const p of ps) {
      const f = nodeFlow.get(p) ?? 0;
      if (f <= ATTRIBUTION_EPS) continue;
      const share = (f / totalParentFlow) * nClaim;
      claim.set(p, (claim.get(p) ?? 0) + share);
      const rc = remainingChildren.get(p)! - 1;
      remainingChildren.set(p, rc);
      if (rc === 0) ready.push(p);
    }
  }

  // Cycle detection: in a pure DAG Kahn's algorithm visits every ancestor.
  // Any ancestor that wasn't visited sits inside a strongly-connected
  // component (or on a branch entirely composed of zero-flow nodes the walk
  // pruned). The first cause is a real cycle; the second is a normal
  // unresolved branch. We flag a cycle only when an unprocessed ancestor
  // *received* a claim that had nowhere to go — that's the symptom of being
  // trapped inside an SCC, not of a dead branch.
  let cycleDetected = false;
  for (const [n, c] of claim) {
    if (!processed.has(n) && c > ATTRIBUTION_EPS) {
      cycleDetected = true;
      break;
    }
  }

  // Total attributed share is the sum across `sources`. Anything missing
  // from 1 is the unresolved fraction (claim that died at a no-flow branch
  // or was swallowed by a cycle).
  let attributed = 0;
  for (const v of sources.values()) attributed += v;
  const unresolved = Math.max(0, 1 - attributed);

  const rows: AttributedSource[] = [];
  for (const [name, fraction] of sources) {
    const t = typeOf.get(name) ?? "";
    rows.push({
      name,
      nodeType: t,
      role: classifySource(t),
      fraction,
      contribution: fraction * sinkFlow,
      recordedFlow: nodeFlow.get(name) ?? 0,
    });
  }
  rows.sort((a, b) => {
    if (b.fraction !== a.fraction) return b.fraction - a.fraction;
    return a.name.localeCompare(b.name);
  });

  return {
    sinkName,
    sinkFlow,
    sources: rows,
    unresolved,
    cycleDetected,
    error: null,
  };
}

// Format a fraction in [0, 1] as a percentage with sensible precision.
// Mirrors formatReliability so the two views read consistently in the same UI.
export function formatFraction(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const pct = v * 100;
  if (pct >= 99.95) return "100%";
  if (pct <= 0.05 && pct > 0) return "<0.1%";
  if (pct === 0) return "0%";
  return `${pct.toFixed(1)}%`;
}

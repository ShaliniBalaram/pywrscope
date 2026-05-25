// src/utils/dagreLayout.ts
// Computes a hierarchical DAG layout for a Pywr network using dagre.
// Returns a map of node name → {x, y} in ReactFlow coordinate space.

import dagre from "@dagrejs/dagre";
import type { PywrEdge } from "../types/pywr";

const NODE_W = 80;  // assumed node width for dagre spacing
const NODE_H = 80;  // assumed node height

export function computeDagreLayout(
  nodeNames: string[],
  edges: readonly PywrEdge[],
): Record<string, { x: number; y: number }> {
  const g = new dagre.graphlib.Graph();
  g.setGraph({
    rankdir: "LR",   // left → right (upstream → downstream)
    nodesep: 80,     // vertical spacing between nodes in same rank
    ranksep: 160,    // horizontal spacing between ranks
    marginx: 60,
    marginy: 60,
  });
  g.setDefaultEdgeLabel(() => ({}));

  for (const name of nodeNames) {
    g.setNode(name, { width: NODE_W, height: NODE_H });
  }

  const nameSet = new Set(nodeNames);
  for (const edge of edges) {
    const [from, to] = edge;
    if (nameSet.has(from) && nameSet.has(to)) {
      g.setEdge(from, to);
    }
  }

  dagre.layout(g);

  const positions: Record<string, { x: number; y: number }> = {};
  for (const name of nodeNames) {
    const node = g.node(name);
    if (node) {
      positions[name] = {
        x: Math.round(node.x - NODE_W / 2),
        y: Math.round(node.y - NODE_H / 2),
      };
    }
  }
  return positions;
}

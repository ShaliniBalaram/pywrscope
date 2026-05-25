// src/utils/dagreLayout.ts
// Computes a hierarchical DAG layout for a Pywr network using dagre.
// Returns a map of node name → {x, y} in ReactFlow coordinate space.

import dagre from "@dagrejs/dagre";
import type { PywrEdge, PywrModel, PywrNode } from "../types/pywr";

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

const REFERENCE_NODE_TYPES = new Set([
  "aggregatednode",
  "aggregatedstorage",
  "virtualstorage",
  "annualvirtualstorage",
  "seasonalvirtualstorage",
  "monthlyvirtualstorage",
  "rollingvirtualstorage",
]);

function referencedNodes(node: PywrNode, validNames: Set<string>): string[] {
  const refs = new Set<string>();
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      if (key && key.toLowerCase().includes("node") && validNames.has(value)) {
        refs.add(value);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      visit(childValue, childKey);
    }
  };
  visit(node, null);
  refs.delete(node.name);
  return [...refs];
}

function centroid(
  names: string[],
  positions: Record<string, { x: number; y: number }>,
): { x: number; y: number } | null {
  const pts = names.map((n) => positions[n]).filter(Boolean);
  if (pts.length === 0) return null;
  return {
    x: pts.reduce((sum, p) => sum + p.x, 0) / pts.length,
    y: pts.reduce((sum, p) => sum + p.y, 0) / pts.length,
  };
}

export function computePywrModelLayout(model: PywrModel): Record<string, { x: number; y: number }> {
  const nodeNames = model.nodes.map((n) => n.name);
  const positions = computeDagreLayout(nodeNames, model.edges);
  const validNames = new Set(nodeNames);
  const connected = new Set<string>();
  for (const [from, to] of model.edges) {
    connected.add(from);
    connected.add(to);
  }

  const anchorCounts = new Map<string, number>();
  for (const node of model.nodes) {
    const type = node.type.toLowerCase();
    const refs = referencedNodes(node, validNames);
    const isReferenceNode = REFERENCE_NODE_TYPES.has(type) || refs.length > 0;
    if (connected.has(node.name) || !isReferenceNode) continue;

    const centre = centroid(refs, positions);
    if (!centre) continue;

    const anchor = refs.sort().join("|");
    const index = anchorCounts.get(anchor) ?? 0;
    anchorCounts.set(anchor, index + 1);
    positions[node.name] = {
      x: Math.round(centre.x + 70 + (index % 3) * 36),
      y: Math.round(centre.y - 70 + Math.floor(index / 3) * 36),
    };
  }

  return positions;
}

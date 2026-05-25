// src/lib/sankeyLayout.ts
// Pure layout helpers for the T2.5 annual-Sankey view.
//
// Input: a list of edges with per-edge aggregated flows (written by the
// Python runner's edge_flows.json — see src-tauri/python/run_pywr.py).
//
// Output: a fully laid-out diagram — node positions, node heights, edge
// ribbons (SVG path strings) and ribbon widths. The renderer is then just a
// thin SVG layer with no math of its own.
//
// Approach:
//   1. Longest-path layering. Source nodes (no incoming edges in the
//      flow graph) land in layer 0. Every other node sits at
//      max(layer of any parent) + 1. Cycles, if any, are broken by placing
//      every node touched by a cycle at layer 0 (rare in Pywr models, but
//      we don't want a NaN-y crash).
//   2. Within-layer ordering: by descending throughput, with ties broken by
//      name. Avoids the heavyweight crossing-minimisation pass; for typical
//      Pywr networks (≤ 50 nodes) the difference is cosmetic.
//   3. Node heights scale with throughput. Within a layer we stack vertically
//      with a fixed gap; the layout's overall height is the tallest layer.
//   4. Edge ribbons. For each node we allocate vertical stripes proportional
//      to flow for both inbound and outbound edges (sorted to match the
//      counterparty's vertical position so ribbons don't cross each node).
//      Each ribbon is a cubic Bézier with horizontal handles at 50% of the
//      gap between layers.

export interface SankeyEdgeInput {
  u: string;
  v: string;
  total: number;
  annual: number | null;
}

export interface SankeyData {
  edges: SankeyEdgeInput[];
  totalRoutes: number;
  timesteps: number;
}

export interface SankeyLayoutOpts {
  width?: number;
  // Pixel height for the unit of throughput. Auto-scaled so the tallest
  // layer fits in `maxHeight` when not set. Setting this explicitly is
  // useful for tests that need deterministic geometry.
  heightPerUnit?: number;
  maxHeight?: number;
  // Gap between stacked nodes within a single layer.
  nodeGap?: number;
  // Pixel width of each node bar.
  nodeWidth?: number;
  // Minimum height of any node — keeps tiny throughputs visible.
  minNodeHeight?: number;
  // Minimum ribbon width — keeps a hairline visible for tiny flows.
  minRibbonWidth?: number;
}

export interface LaidOutNode {
  name: string;
  layer: number;
  x: number;
  y: number;
  height: number;
  inFlow: number;
  outFlow: number;
  // throughput = max(inFlow, outFlow). Drives the bar height.
  throughput: number;
}

export interface LaidOutEdge {
  u: string;
  v: string;
  total: number;
  annual: number | null;
  // SVG path string for the ribbon, rooted at the right of the source node
  // and ending at the left of the target node.
  path: string;
  // Stroke width in pixels (proportional to flow).
  width: number;
  // Y coordinates of the ribbon's centre at the source and target faces.
  // Surfaced so a hover legend can pin the tooltip without re-measuring.
  ySrc: number;
  yDst: number;
}

export interface SankeyLayoutResult {
  nodes: LaidOutNode[];
  edges: LaidOutEdge[];
  // Outer SVG dimensions to set on the <svg> element.
  width: number;
  height: number;
  // Diagnostic: nodes whose throughput is zero are dropped from the layout
  // because they'd render as zero-height bars. We list them so the UI can
  // surface a hint.
  droppedNodes: string[];
  // Set when a cycle was detected during the layering pass — surfaced for the
  // UI so the user knows the layer assignment may be approximate.
  cycleDetected: boolean;
}

const DEFAULTS: Required<SankeyLayoutOpts> = {
  width: 960,
  heightPerUnit: 0, // 0 = auto
  maxHeight: 640,
  nodeGap: 8,
  nodeWidth: 14,
  minNodeHeight: 4,
  minRibbonWidth: 0.6,
};

// Build the directed graph from edges and assign each node its layer.
// Returns the layer assignment plus a cycle-detected flag.
function assignLayers(
  nodes: string[],
  parents: Map<string, string[]>,
  children: Map<string, string[]>,
): { layer: Map<string, number>; cycleDetected: boolean } {
  const layer = new Map<string, number>();
  // Kahn-style topological order. Every node starts with inDegree = #parents
  // and is enqueued when it hits 0. We compute layer[n] = max(layer[parent])
  // + 1 during processing — this gives the longest-path layer.
  const inDeg = new Map<string, number>();
  for (const n of nodes) inDeg.set(n, parents.get(n)?.length ?? 0);

  const queue: string[] = [];
  for (const n of nodes) {
    if ((inDeg.get(n) ?? 0) === 0) {
      layer.set(n, 0);
      queue.push(n);
    }
  }

  let processed = 0;
  while (queue.length > 0) {
    const n = queue.shift()!;
    processed++;
    const lyr = layer.get(n) ?? 0;
    for (const c of children.get(n) ?? []) {
      const prev = layer.get(c);
      const candidate = lyr + 1;
      if (prev === undefined || candidate > prev) layer.set(c, candidate);
      const d = (inDeg.get(c) ?? 0) - 1;
      inDeg.set(c, d);
      if (d === 0) queue.push(c);
    }
  }

  // Cycle handling: any node we couldn't process sits inside a cycle (or is
  // downstream of one). Place each such node at layer 0 so the layout still
  // renders. This is rare in Pywr models — surfaced via cycleDetected.
  let cycleDetected = false;
  if (processed < nodes.length) {
    cycleDetected = true;
    for (const n of nodes) {
      if (!layer.has(n)) layer.set(n, 0);
    }
  }
  return { layer, cycleDetected };
}

// Build adjacency maps from edges. Cells with zero or negative total are
// dropped — they don't carry flow and don't belong in the Sankey.
function buildAdjacency(edges: SankeyEdgeInput[]) {
  const nodes = new Set<string>();
  const parents = new Map<string, string[]>();
  const children = new Map<string, string[]>();
  const usable: SankeyEdgeInput[] = [];
  for (const e of edges) {
    if (!Number.isFinite(e.total) || e.total <= 0) continue;
    if (!e.u || !e.v) continue;
    nodes.add(e.u);
    nodes.add(e.v);
    if (!children.has(e.u)) children.set(e.u, []);
    children.get(e.u)!.push(e.v);
    if (!parents.has(e.v)) parents.set(e.v, []);
    parents.get(e.v)!.push(e.u);
    usable.push(e);
  }
  return { nodes: Array.from(nodes), parents, children, usable };
}

export function computeSankeyLayout(
  data: SankeyData,
  opts: SankeyLayoutOpts = {},
): SankeyLayoutResult {
  const o = { ...DEFAULTS, ...opts };
  const { nodes, parents, children, usable } = buildAdjacency(data.edges);

  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: o.width,
      height: o.maxHeight,
      droppedNodes: [],
      cycleDetected: false,
    };
  }

  const { layer, cycleDetected } = assignLayers(nodes, parents, children);

  // Per-node throughput. inFlow = sum of edges into n; outFlow = sum out.
  const inFlow = new Map<string, number>();
  const outFlow = new Map<string, number>();
  for (const e of usable) {
    outFlow.set(e.u, (outFlow.get(e.u) ?? 0) + e.total);
    inFlow.set(e.v, (inFlow.get(e.v) ?? 0) + e.total);
  }
  const throughput = new Map<string, number>();
  for (const n of nodes) {
    throughput.set(n, Math.max(inFlow.get(n) ?? 0, outFlow.get(n) ?? 0));
  }

  // Group nodes by layer.
  const layerCount = Math.max(...Array.from(layer.values())) + 1;
  const byLayer: string[][] = Array.from({ length: layerCount }, () => []);
  const droppedNodes: string[] = [];
  for (const n of nodes) {
    if ((throughput.get(n) ?? 0) <= 0) {
      droppedNodes.push(n);
      continue;
    }
    byLayer[layer.get(n) ?? 0].push(n);
  }
  for (const list of byLayer) {
    list.sort((a, b) => {
      const ta = throughput.get(a) ?? 0;
      const tb = throughput.get(b) ?? 0;
      if (tb !== ta) return tb - ta;
      return a.localeCompare(b);
    });
  }

  // Auto-scale heightPerUnit so the tallest layer fits within maxHeight.
  const tallestLayerThroughput = byLayer.reduce((m, list) => {
    let s = 0;
    for (const n of list) s += throughput.get(n) ?? 0;
    return Math.max(m, s);
  }, 0);
  const tallestLayerGapBudget = byLayer.reduce((m, list) => {
    return Math.max(m, Math.max(0, list.length - 1) * o.nodeGap);
  }, 0);
  // Add a min-height budget so layout doesn't under-scale when many small
  // nodes each get clamped up.
  const minHeightBudget = byLayer.reduce((m, list) => {
    return Math.max(m, list.length * o.minNodeHeight);
  }, 0);

  let heightPerUnit = o.heightPerUnit;
  if (heightPerUnit <= 0) {
    if (tallestLayerThroughput <= 0) {
      heightPerUnit = 1;
    } else {
      const budget = Math.max(
        1,
        o.maxHeight - tallestLayerGapBudget - minHeightBudget,
      );
      heightPerUnit = budget / tallestLayerThroughput;
    }
  }

  // Assign x and y per node. Layers are evenly spaced across `width`.
  const innerWidth = o.width - o.nodeWidth;
  const layerStride = layerCount <= 1 ? 0 : innerWidth / (layerCount - 1);

  // Compute per-node y by stacking within the layer. Centre each layer
  // vertically so the diagram doesn't drift up when one layer is short.
  const laidNodes: LaidOutNode[] = [];
  const nodePos = new Map<string, LaidOutNode>();
  // First pass: compute overallHeight only. We could memoise the per-node
  // height arrays here to skip re-deriving them in the position pass below,
  // but the cost is a tiny multiplication per node and keeping the two
  // passes shape-independent makes the code easier to read.
  let overallHeight = 0;
  for (const list of byLayer) {
    let totalHeight = 0;
    for (const n of list) {
      totalHeight += Math.max(o.minNodeHeight, (throughput.get(n) ?? 0) * heightPerUnit);
    }
    totalHeight += Math.max(0, list.length - 1) * o.nodeGap;
    if (totalHeight > overallHeight) overallHeight = totalHeight;
  }

  for (let li = 0; li < byLayer.length; li++) {
    const list = byLayer[li];
    let totalHeight = 0;
    const heights = list.map((n) => {
      const h = Math.max(o.minNodeHeight, (throughput.get(n) ?? 0) * heightPerUnit);
      totalHeight += h;
      return h;
    });
    totalHeight += Math.max(0, list.length - 1) * o.nodeGap;
    let y = (overallHeight - totalHeight) / 2;
    for (let i = 0; i < list.length; i++) {
      const name = list[i];
      const x = li * layerStride;
      const node: LaidOutNode = {
        name,
        layer: li,
        x,
        y,
        height: heights[i],
        inFlow: inFlow.get(name) ?? 0,
        outFlow: outFlow.get(name) ?? 0,
        throughput: throughput.get(name) ?? 0,
      };
      laidNodes.push(node);
      nodePos.set(name, node);
      y += heights[i] + o.nodeGap;
    }
  }

  // Allocate per-node ribbon offsets. For each node, we order its outbound
  // edges by the target's vertical position (top → bottom) and stack them
  // along the right face proportional to flow; same for inbound edges along
  // the left face. This minimises crossings for adjacent nodes without
  // needing the full sweep used by D3-sankey.
  const outOffset = new Map<string, Map<string, number>>(); // u → {v → yStart}
  const inOffset = new Map<string, Map<string, number>>();  // v → {u → yStart}
  for (const node of laidNodes) {
    // Outbound stripes.
    const outs = (children.get(node.name) ?? [])
      .filter((v) => nodePos.has(v))
      .map((v) => {
        const targetCenter =
          (nodePos.get(v)!.y + nodePos.get(v)!.height / 2);
        // Recover this edge's flow by looking it up. usable list is the
        // ground truth.
        return { v, targetCenter };
      });
    // De-dup on (u→v) — parallel edges in source data collapse to one stripe.
    const uniqOuts: Array<{ v: string; targetCenter: number }> = [];
    const seen = new Set<string>();
    for (const o2 of outs) {
      if (seen.has(o2.v)) continue;
      seen.add(o2.v);
      uniqOuts.push(o2);
    }
    uniqOuts.sort((a, b) => a.targetCenter - b.targetCenter);
    const map = new Map<string, number>();
    let cursor = node.y;
    const outScale = node.outFlow > 0 ? node.height / node.outFlow : 0;
    for (const o2 of uniqOuts) {
      const edge = usable.find((e) => e.u === node.name && e.v === o2.v);
      if (!edge) continue;
      const stripe = Math.max(o.minRibbonWidth, edge.total * outScale);
      map.set(o2.v, cursor + stripe / 2);
      cursor += stripe;
    }
    outOffset.set(node.name, map);

    // Inbound stripes.
    const ins = (parents.get(node.name) ?? [])
      .filter((u) => nodePos.has(u))
      .map((u) => {
        const sourceCenter =
          (nodePos.get(u)!.y + nodePos.get(u)!.height / 2);
        return { u, sourceCenter };
      });
    const uniqIns: Array<{ u: string; sourceCenter: number }> = [];
    const seenIn = new Set<string>();
    for (const ii of ins) {
      if (seenIn.has(ii.u)) continue;
      seenIn.add(ii.u);
      uniqIns.push(ii);
    }
    uniqIns.sort((a, b) => a.sourceCenter - b.sourceCenter);
    const inMap = new Map<string, number>();
    let inCursor = node.y;
    const inScale = node.inFlow > 0 ? node.height / node.inFlow : 0;
    for (const ii of uniqIns) {
      const edge = usable.find((e) => e.u === ii.u && e.v === node.name);
      if (!edge) continue;
      const stripe = Math.max(o.minRibbonWidth, edge.total * inScale);
      inMap.set(ii.u, inCursor + stripe / 2);
      inCursor += stripe;
    }
    inOffset.set(node.name, inMap);
  }

  // Build the laid-out edges.
  const laidEdges: LaidOutEdge[] = [];
  for (const edge of usable) {
    const src = nodePos.get(edge.u);
    const dst = nodePos.get(edge.v);
    if (!src || !dst) continue;
    const ySrc = outOffset.get(edge.u)?.get(edge.v);
    const yDst = inOffset.get(edge.v)?.get(edge.u);
    if (ySrc === undefined || yDst === undefined) continue;

    const x0 = src.x + o.nodeWidth;
    const x1 = dst.x;
    const cx = (x0 + x1) / 2;
    // Cubic Bézier with horizontal control points at the midpoint x. This
    // gives the smooth S-curve characteristic of Sankey diagrams.
    const path = `M ${x0.toFixed(2)} ${ySrc.toFixed(2)} C ${cx.toFixed(2)} ${ySrc.toFixed(2)}, ${cx.toFixed(2)} ${yDst.toFixed(2)}, ${x1.toFixed(2)} ${yDst.toFixed(2)}`;

    // Ribbon width proportional to flow. Same scale as in/out stripes —
    // taken from the smaller of the two endpoints' scales so the ribbon
    // visually matches the smaller of its two stripe slots.
    const outScale = src.outFlow > 0 ? src.height / src.outFlow : 0;
    const inScale = dst.inFlow > 0 ? dst.height / dst.inFlow : 0;
    const stripe = Math.max(
      o.minRibbonWidth,
      edge.total * Math.min(outScale || Infinity, inScale || Infinity),
    );

    laidEdges.push({
      u: edge.u,
      v: edge.v,
      total: edge.total,
      annual: edge.annual,
      path,
      width: stripe,
      ySrc,
      yDst,
    });
  }

  return {
    nodes: laidNodes,
    edges: laidEdges,
    width: o.width,
    height: Math.max(o.minNodeHeight, overallHeight),
    droppedNodes,
    cycleDetected,
  };
}

// Pretty-print a flow volume for the Sankey labels. Uses K / M / G suffixes
// so a thousand-fold range fits in 4 chars. Matches the visual density of
// the mass-balance summary cards.
export function formatSankeyFlow(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs === 0) return "0";
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}G`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(2)}k`;
  if (abs >= 100) return v.toFixed(0);
  if (abs >= 1) return v.toFixed(2);
  return v.toFixed(3);
}

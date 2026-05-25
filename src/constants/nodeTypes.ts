// src/constants/nodeTypes.ts
// Single source of truth for visual representation of each Pywr node type.
// Colours, shapes, display labels, and default fields when creating new nodes.
// All node types derive from PYWR_SCHEMA.md.
// No Math.random(). No invented colours (#000000, #ffffff not used).

import { PywrNode } from "../types/pywr";

// ---------------------------------------------------------------------------
// Shape types
// ---------------------------------------------------------------------------
export type NodeShapeType = "diamond" | "rectangle" | "circle" | "hexagon";
export type NodeBorderStyle = "solid" | "dashed" | "thick";

export interface NodeShape {
  shape: NodeShapeType;
  border: NodeBorderStyle;
}

// ---------------------------------------------------------------------------
// NODE_COLOUR_MAP — one entry per Pywr node type from PYWR_SCHEMA.md
// ---------------------------------------------------------------------------
export const NODE_COLOUR_MAP: Record<string, string> = {
  // Core
  Input:                    "#3B8BD4",  // blue
  Catchment:                "#3B8BD4",  // blue
  Discharge:                "#69C46A",  // light green
  Link:                     "#EF9F27",  // amber
  LossLink:                 "#E64980",  // pink
  BreakLink:                "#868E96",  // grey
  DelayNode:                "#BE4BDB",  // purple
  Output:                   "#1D9E75",  // teal
  // Multi-output
  PiecewiseLink:            "#F76707",  // deep orange
  MultiSplitLink:           "#F783AC",  // light pink
  // Storage
  Storage:                  "#7F77DD",  // purple
  Reservoir:                "#74C0FC",  // light blue
  // Virtual storage / licence
  VirtualStorage:           "#888780",  // grey
  AnnualVirtualStorage:     "#20C997",  // teal
  SeasonalVirtualStorage:   "#0CA678",  // teal darker
  MonthlyVirtualStorage:    "#099268",  // teal darkest
  RollingVirtualStorage:    "#087F5B",  // forest teal
  // Aggregation
  AggregatedNode:           "#D85A30",  // coral
  AggregatedStorage:        "#D85A30",  // coral
  // River domain
  River:                    "#5DCAA5",  // light teal
  RiverGauge:               "#CC5DE8",  // violet
  RiverSplit:               "#F06595",  // rose
  RiverSplitWithGauge:      "#E599F7",  // light violet
  // Groundwater
  KeatingAquifer:           "#748FFC",  // indigo
};

// ---------------------------------------------------------------------------
// NODE_SHAPE_MAP — one entry per Pywr node type
// ---------------------------------------------------------------------------
export const NODE_SHAPE_MAP: Record<string, NodeShape> = {
  // Core
  Input:                    { shape: "diamond",   border: "solid" },
  Catchment:                { shape: "diamond",   border: "solid" },
  Discharge:                { shape: "diamond",   border: "solid" },
  Link:                     { shape: "rectangle", border: "solid" },
  LossLink:                 { shape: "circle",    border: "solid" },
  BreakLink:                { shape: "circle",    border: "dashed" },
  DelayNode:                { shape: "rectangle", border: "solid" },
  Output:                   { shape: "rectangle", border: "solid" },
  // Multi-output
  PiecewiseLink:            { shape: "rectangle", border: "thick" },
  MultiSplitLink:           { shape: "rectangle", border: "thick" },
  // Storage
  Storage:                  { shape: "circle",    border: "solid" },
  Reservoir:                { shape: "circle",    border: "solid" },
  // Virtual storage / licence
  VirtualStorage:           { shape: "circle",    border: "dashed" },
  AnnualVirtualStorage:     { shape: "rectangle", border: "dashed" },
  SeasonalVirtualStorage:   { shape: "rectangle", border: "dashed" },
  MonthlyVirtualStorage:    { shape: "rectangle", border: "dashed" },
  RollingVirtualStorage:    { shape: "rectangle", border: "dashed" },
  // Aggregation
  AggregatedNode:           { shape: "hexagon",   border: "solid" },
  AggregatedStorage:        { shape: "circle",    border: "solid" },
  // River domain
  River:                    { shape: "rectangle", border: "dashed" },
  RiverGauge:               { shape: "rectangle", border: "dashed" },
  RiverSplit:               { shape: "diamond",   border: "solid" },
  RiverSplitWithGauge:      { shape: "diamond",   border: "solid" },
  // Groundwater
  KeatingAquifer:           { shape: "rectangle", border: "solid" },
};

// ---------------------------------------------------------------------------
// NODE_DISPLAY_LABELS — human-friendly name for each node type
// ---------------------------------------------------------------------------
export const NODE_DISPLAY_LABELS: Record<string, string> = {
  // Core
  Input:                    "Input",
  Catchment:                "Catchment",
  Discharge:                "Discharge",
  Link:                     "Link",
  LossLink:                 "Loss Link",
  BreakLink:                "Break Link",
  DelayNode:                "Delay Node",
  Output:                   "Output (Demand)",
  // Multi-output
  PiecewiseLink:            "Piecewise Link",
  MultiSplitLink:           "Multi-Split Link",
  // Storage
  Storage:                  "Storage",
  Reservoir:                "Reservoir",
  // Virtual storage / licence
  VirtualStorage:           "Virtual Storage",
  AnnualVirtualStorage:     "Annual Licence (VS)",
  SeasonalVirtualStorage:   "Seasonal Licence (VS)",
  MonthlyVirtualStorage:    "Monthly Licence (VS)",
  RollingVirtualStorage:    "Rolling Licence (VS)",
  // Aggregation
  AggregatedNode:           "Aggregated Node",
  AggregatedStorage:        "Aggregated Storage",
  // River domain
  River:                    "River",
  RiverGauge:               "River Gauge",
  RiverSplit:               "River Split",
  RiverSplitWithGauge:      "River Split w/ Gauge",
  // Groundwater
  KeatingAquifer:           "Keating Aquifer",
};

// ---------------------------------------------------------------------------
// NODE_DEFAULT_FIELDS — minimum valid fields when creating a new node.
// name is NOT included here — it is generated by NodePalette with uniqueness.
// All required fields from PYWR_SCHEMA.md are included.
// ---------------------------------------------------------------------------
export const NODE_DEFAULT_FIELDS: Record<string, Partial<PywrNode>> = {
  // Core
  Input:                    { type: "Input" } as Partial<PywrNode>,
  Catchment:                { type: "Catchment" } as Partial<PywrNode>,
  Discharge:                { type: "Discharge" } as Partial<PywrNode>,
  Link:                     { type: "Link" } as Partial<PywrNode>,
  LossLink:                 { type: "LossLink" } as Partial<PywrNode>,
  BreakLink:                { type: "BreakLink" } as Partial<PywrNode>,
  DelayNode:                { type: "DelayNode", days: 1 } as Partial<PywrNode>,
  Output:                   { type: "Output" } as Partial<PywrNode>,
  // Multi-output
  PiecewiseLink:            { type: "PiecewiseLink", nsteps: 2 } as Partial<PywrNode>,
  MultiSplitLink:           { type: "MultiSplitLink", nsteps: 2, extra_slots: 1 } as Partial<PywrNode>,
  // Storage
  Storage:                  { type: "Storage", max_volume: 0, initial_volume_pc: 1.0 } as Partial<PywrNode>,
  Reservoir:                { type: "Reservoir", max_volume: 0, initial_volume_pc: 1.0 } as Partial<PywrNode>,
  // Virtual storage / licence
  VirtualStorage:           { type: "VirtualStorage", nodes: [] } as Partial<PywrNode>,
  AnnualVirtualStorage:     { type: "AnnualVirtualStorage", nodes: [], max_volume: 0 } as Partial<PywrNode>,
  SeasonalVirtualStorage:   { type: "SeasonalVirtualStorage", nodes: [] } as Partial<PywrNode>,
  MonthlyVirtualStorage:    { type: "MonthlyVirtualStorage", nodes: [], months: 1 } as Partial<PywrNode>,
  RollingVirtualStorage:    { type: "RollingVirtualStorage", nodes: [], days: 30 } as Partial<PywrNode>,
  // Aggregation
  AggregatedNode:           { type: "AggregatedNode", nodes: [] } as Partial<PywrNode>,
  AggregatedStorage:        { type: "AggregatedStorage", storages: [] } as Partial<PywrNode>,
  // River domain
  River:                    { type: "River" } as Partial<PywrNode>,
  RiverGauge:               { type: "RiverGauge" } as Partial<PywrNode>,
  RiverSplit:               { type: "RiverSplit" } as Partial<PywrNode>,
  RiverSplitWithGauge:      { type: "RiverSplitWithGauge" } as Partial<PywrNode>,
  // Groundwater
  KeatingAquifer:           { type: "KeatingAquifer", num_streams: 1, num_additional_inputs: 1 } as Partial<PywrNode>,
};

// Ordered list of all node types — used for palette iteration
export const NODE_TYPES: string[] = Object.keys(NODE_COLOUR_MAP);

// ---------------------------------------------------------------------------
// normalizeNodeType — maps any casing variant (e.g. "losslink", "LOSSLINK")
// to the canonical PascalCase key used in the maps above (e.g. "LossLink").
// Returns the original string if no match is found.
// ---------------------------------------------------------------------------
const _TYPE_LOOKUP: Record<string, string> = {};
for (const key of Object.keys(NODE_COLOUR_MAP)) {
  _TYPE_LOOKUP[key.toLowerCase()] = key;
}
export function normalizeNodeType(type: string): string {
  return _TYPE_LOOKUP[type.toLowerCase()] ?? type;
}

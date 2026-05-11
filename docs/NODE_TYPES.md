# NODE_TYPES.md — Visual representation of Pywr node types

## Purpose

This file defines exactly how each Pywr node type is drawn on the canvas.
All values here are used by `src/constants/nodeTypes.ts`.
Do not change these values without updating nodeTypes.ts as well.

---

## Visual node type table

| Pywr type            | Display label              | Colour  | Shape     | Border style | Category          |
|----------------------|----------------------------|---------|-----------|--------------|-------------------|
| Input                | GW Source / Input          | #3B8BD4 | diamond   | solid 1.5px  | Sources           |
| Catchment            | Catchment                  | #3B8BD4 | diamond   | solid 1.5px  | Sources           |
| Output               | Demand Centre              | #1D9E75 | rectangle | solid 1.5px  | Demand            |
| Link                 | Treatment / Transfer       | #EF9F27 | rectangle | solid 1.5px  | Treatment         |
| PiecewiseLink        | Piecewise Link             | #EF9F27 | rectangle | solid 2.5px  | Treatment         |
| AggregatedNode       | Aggregated Node            | #D85A30 | hexagon   | solid 1.5px  | Aggregation       |
| Storage              | Reservoir / Storage        | #7F77DD | circle    | solid 1.5px  | Water bodies      |
| River                | River                      | #5DCAA5 | rectangle | dashed 1.5px | Water bodies      |
| RiverGauge           | River Gauge                | #5DCAA5 | rectangle | dashed 1.5px | Water bodies      |
| RiverSplitWithGauge  | River Split + Gauge        | #5DCAA5 | diamond   | dashed 1.5px | Water bodies      |
| AnnualVirtualStorage | Annual Licence (VS)        | #888780 | rectangle | dashed 1.5px | Licence tracking  |
| VirtualStorage       | Virtual Storage            | #888780 | circle    | dashed 1.5px | Licence tracking  |
| AggregatedStorage    | Aggregated Storage         | #D85A30 | circle    | solid 1.5px  | Aggregation       |

---

## Node size

All nodes are rendered at a consistent size for readability:

| Shape     | Width | Height |
|-----------|-------|--------|
| rectangle | 160px | 44px   |
| diamond   | 60px  | 60px   |
| circle    | 60px  | 60px   |
| hexagon   | 60px  | 60px   |

The label text is always the node's `name` property, not its type.
Font: 12px, single line, truncated with ellipsis if longer than the node width.

---

## Recorder badge

When a node has a recorder attached, a small badge appears in the top-right
corner of the node:

- NumpyArrayNodeRecorder → small grey dot
- NumpyArrayDeficitNodeRecorder → small red dot
- NumpyArrayStorageRecorder → small purple dot
- NumpyArrayNormalisedStorageRecorder → small purple dot (outlined)

If a node has NO recorder, a small amber warning triangle appears instead.

---

## Edge style

All edges use the same style:

- Stroke colour: `#888780` (grey) at 60% opacity
- Stroke width: 1.5px
- Arrow head: open chevron, 6px
- Curve type: smoothstep (React Flow default)

Selected edge: stroke colour becomes `#3B8BD4` (blue), width 2px.

---

## Selection state

Selected node: border width increases to 3px, border colour becomes `#3B8BD4`.
All other nodes: opacity reduces to 70% while a node is selected.

---

## Palette grouping

The node palette in the left sidebar groups types as follows:

### Sources
- Input
- Catchment

### Treatment & Transfer
- Link
- PiecewiseLink

### Demand
- Output

### Water Bodies
- River
- RiverGauge
- RiverSplitWithGauge
- Storage

### Aggregation
- AggregatedNode
- AggregatedStorage

### Licence Tracking
- AnnualVirtualStorage
- VirtualStorage

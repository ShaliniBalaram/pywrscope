// src/components/NodePalette.tsx
// Left sidebar showing all Pywr node types as draggable tiles.
// Dragging a tile onto the canvas creates a new node of that type.
// New node names are unique — suffix _2, _3, etc. if name already exists.

import React from "react";
import { PywrModel, PywrNode } from "../types/pywr";
import {
  NODE_COLOUR_MAP,
  NODE_DISPLAY_LABELS,
  NODE_DEFAULT_FIELDS,
} from "../constants/nodeTypes";

interface NodePaletteProps {
  model: PywrModel | null;
  addNode: (node: PywrNode) => void;
  setPosition: (name: string, x: number, y: number) => void;
}

// Palette groups — order matches water engineering convention
const PALETTE_GROUPS: Array<{ label: string; types: string[] }> = [
  { label: "Sources",          types: ["Input", "Catchment", "Discharge"] },
  { label: "Flow Control",     types: ["Link", "LossLink", "BreakLink", "DelayNode"] },
  { label: "Multi-Output",     types: ["PiecewiseLink", "MultiSplitLink"] },
  { label: "Demand",           types: ["Output"] },
  { label: "Water Bodies",     types: ["Storage", "Reservoir", "River", "RiverGauge"] },
  { label: "River Routing",    types: ["RiverSplit", "RiverSplitWithGauge"] },
  { label: "Groundwater",      types: ["KeatingAquifer"] },
  { label: "Licence Tracking", types: ["VirtualStorage", "AnnualVirtualStorage", "SeasonalVirtualStorage", "MonthlyVirtualStorage", "RollingVirtualStorage"] },
  { label: "Aggregation",      types: ["AggregatedNode", "AggregatedStorage"] },
];

// Generate a unique node name for the given type
function uniqueName(nodeType: string, existingNames: Set<string>): string {
  const base = nodeType;
  if (!existingNames.has(base)) return base;
  let i = 2;
  while (existingNames.has(`${base}_${i}`)) i++;
  return `${base}_${i}`;
}

function PaletteTile({
  nodeType,
  groupLabel,
}: {
  nodeType: string;
  groupLabel: string;
}) {
  const colour = NODE_COLOUR_MAP[nodeType] ?? "#888";
  const label =
    groupLabel === "Treatment" && nodeType === "Link"
      ? "WTW Treatment Link"
      : NODE_DISPLAY_LABELS[nodeType] ?? nodeType;

  function onDragStart(e: React.DragEvent) {
    // Encode nodeType + palette group so Canvas knows what to create
    e.dataTransfer.setData(
      "application/pywr-node-type",
      // Treatment group Links carry a _WTW convention hint — but they are still
      // plain Link nodes. The user can rename after creation.
      nodeType
    );
    e.dataTransfer.effectAllowed = "move";
  }

  return (
    <div
      draggable
      onDragStart={onDragStart}
      title={`Drag to canvas to add ${label}`}
      style={{
        backgroundColor: colour,
        color: "#fff",
        borderRadius: 6,
        padding: "6px 8px",
        marginBottom: 4,
        cursor: "grab",
        fontSize: 11,
        fontWeight: "bold",
        userSelect: "none",
        border: `1px solid rgba(0,0,0,0.15)`,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
      }}
    >
      {label}
    </div>
  );
}

export function NodePalette({ model, addNode, setPosition }: NodePaletteProps) {
  const existingNames = new Set(model?.nodes.map((n) => n.name) ?? []);

  // NodePalette provides addNode + setPosition via onAddNodeFromPalette prop
  // but that coupling is done in App.tsx. The palette just fires drag events.
  // The Canvas onDrop calls onAddNode which is wired in App.tsx.
  // This component only renders the tiles.

  return (
    <div
      style={{
        width: 160,
        minWidth: 160,
        backgroundColor: "#f7f7f7",
        borderRight: "1px solid #ddd",
        overflowY: "auto",
        padding: "8px 6px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: "bold",
          color: "#666",
          marginBottom: 8,
          textTransform: "uppercase",
          letterSpacing: "0.05em",
        }}
      >
        Node Types
      </div>

      {PALETTE_GROUPS.map((group) => (
        <div key={group.label} style={{ marginBottom: 10 }}>
          <div
            style={{
              fontSize: 10,
              color: "#999",
              fontWeight: "bold",
              marginBottom: 3,
              textTransform: "uppercase",
              letterSpacing: "0.04em",
            }}
          >
            {group.label}
          </div>
          {group.types.map((nodeType) => (
            <PaletteTile
              key={`${group.label}-${nodeType}`}
              nodeType={nodeType}
              groupLabel={group.label}
            />
          ))}
        </div>
      ))}

      {!model && (
        <div
          style={{
            color: "#aaa",
            fontSize: 10,
            marginTop: 12,
            textAlign: "center",
            lineHeight: 1.5,
          }}
        >
          Open a model to start adding nodes
        </div>
      )}
    </div>
  );
}

// Utility exported for use in App.tsx to create a node from a drop event
export function createNodeFromDrop(
  nodeType: string,
  x: number,
  y: number,
  existingNames: Set<string>
): { node: PywrNode; name: string } {
  const name = uniqueName(nodeType, existingNames);
  const defaults = NODE_DEFAULT_FIELDS[nodeType] ?? { type: nodeType as PywrNode["type"] };
  const node = { ...defaults, name, type: nodeType } as PywrNode;
  return { node, name };
}

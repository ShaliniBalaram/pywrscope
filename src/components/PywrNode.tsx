// src/components/PywrNode.tsx
// Network-diagram node rendered as an SVG shape matching the node type.
// Shapes: circle, diamond, rectangle, hexagon — with solid/dashed/thick borders.
// Handles are hidden by default and shown on hover via canvas.css.
// Double-click triggers inline rename (isEditing + onRenameComplete via data).

import React from "react";
import { Handle, Position, NodeProps } from "reactflow";
import type { NodeShape, NodeShapeType } from "../constants/nodeTypes";

interface PywrNodeData {
  label: string;
  nodeType: string;
  colour: string;
  shape: NodeShape;
  highlighted: boolean;
  isEditing: boolean;
  showLabels: boolean;
  onRenameComplete: (newName: string) => void;
}

// Bounding box dimensions per shape type
function shapeDims(shapeType: NodeShapeType): { w: number; h: number } {
  if (shapeType === "rectangle") return { w: 22, h: 12 };
  return { w: 14, h: 14 };
}

// SVG shape element matching pywr-editor conventions
function ShapeSvg({
  shapeType,
  border,
  colour,
  accentColour,
}: {
  shapeType: NodeShapeType;
  border: string;
  colour: string;
  accentColour?: string; // selection / highlight ring colour
}) {
  const { w, h } = shapeDims(shapeType);
  const baseStrokeW = border === "thick" ? 2.5 : 1.5;
  const strokeW = accentColour ? (border === "thick" ? 3.5 : 2.5) : baseStrokeW;
  const stroke = accentColour ?? "rgba(0,0,0,0.22)";
  const dash = border === "dashed" ? "4 2.5" : undefined;
  const m = strokeW / 2; // inset margin so stroke stays inside viewBox

  let shape: React.ReactNode;

  if (shapeType === "circle") {
    const r = w / 2 - m;
    shape = (
      <circle
        cx={w / 2} cy={h / 2} r={r}
        fill={colour} stroke={stroke} strokeWidth={strokeW} strokeDasharray={dash}
      />
    );
  } else if (shapeType === "diamond") {
    shape = (
      <polygon
        points={`${w / 2},${m} ${w - m},${h / 2} ${w / 2},${h - m} ${m},${h / 2}`}
        fill={colour} stroke={stroke} strokeWidth={strokeW} strokeDasharray={dash}
      />
    );
  } else if (shapeType === "rectangle") {
    shape = (
      <rect
        x={m} y={m} width={w - strokeW} height={h - strokeW} rx={2}
        fill={colour} stroke={stroke} strokeWidth={strokeW} strokeDasharray={dash}
      />
    );
  } else {
    // hexagon — flat top (pointy sides)
    const r = w / 2 - m - 0.3;
    const cx = w / 2, cy = h / 2;
    const pts = Array.from({ length: 6 }, (_, i) => {
      const angle = (Math.PI / 3) * i - Math.PI / 6;
      return `${cx + r * Math.cos(angle)},${cy + r * Math.sin(angle)}`;
    }).join(" ");
    shape = (
      <polygon
        points={pts}
        fill={colour} stroke={stroke} strokeWidth={strokeW} strokeDasharray={dash}
      />
    );
  }

  return (
    <svg width={w} height={h} style={{ display: "block", overflow: "visible" }}>
      {shape}
    </svg>
  );
}

export function PywrNodeComponent({ data, selected }: NodeProps<PywrNodeData>) {
  const { label, colour, shape, highlighted, isEditing, showLabels, onRenameComplete } = data;
  const { w, h } = shapeDims(shape.shape);

  const accentColour = highlighted ? "#FFD700" : selected ? "#3b82f6" : undefined;

  return (
    <div style={{ position: "relative", width: w, height: h }}>
      <ShapeSvg
        shapeType={shape.shape}
        border={shape.border}
        colour={colour}
        accentColour={accentColour}
      />

      {/* Label / inline rename input */}
      {isEditing ? (
        <input
          autoFocus
          defaultValue={label}
          onBlur={e => onRenameComplete(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter") onRenameComplete((e.target as HTMLInputElement).value);
            if (e.key === "Escape") onRenameComplete(label);
            e.stopPropagation();
          }}
          onClick={e => e.stopPropagation()}
          style={{
            position: "absolute",
            top: h + 3,
            left: "50%",
            transform: "translateX(-50%)",
            fontSize: 10,
            fontWeight: 500,
            padding: "1px 4px",
            borderRadius: 3,
            border: "1px solid #3b82f6",
            outline: "none",
            width: 90,
            textAlign: "center",
            background: "#fff",
            color: "#1e293b",
            zIndex: 100,
          }}
        />
      ) : showLabels ? (
        <div style={{
          position: "absolute",
          top: h + 4,
          left: "50%",
          transform: "translateX(-50%)",
          whiteSpace: "nowrap",
          fontSize: 10,
          fontWeight: 500,
          color: "#1e293b",
          background: "rgba(255,255,255,0.88)",
          borderRadius: 3,
          padding: "1px 4px",
          pointerEvents: "none",
          maxWidth: 90,
          overflow: "hidden",
          textOverflow: "ellipsis",
          letterSpacing: "0.01em",
        }} title={label}>
          {label}
        </div>
      ) : null}

      {/* Handles — hidden by default, shown on hover via canvas.css */}
      <Handle type="target" position={Position.Top}    style={{ top: -4,    left: "50%",  transform: "translateX(-50%)" }} />
      <Handle type="target" position={Position.Left}   style={{ top: "50%", left: -4,     transform: "translateY(-50%)" }} />
      <Handle type="source" position={Position.Bottom} style={{ bottom: -4, left: "50%",  transform: "translateX(-50%)" }} />
      <Handle type="source" position={Position.Right}  style={{ top: "50%", right: -4,    transform: "translateY(-50%)" }} />
    </div>
  );
}

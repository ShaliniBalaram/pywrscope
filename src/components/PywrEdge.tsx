// src/components/PywrEdge.tsx
// Custom edge matching pywr-editor style:
//   - Straight line, grey, with a filled triangle arrowhead
//   - Arrow placed at 80% along the line (close to target) for clear flow direction
//   - Invisible wide hit area so right-click to delete still works easily
//
// Highlighting:
//   - data.traced=true renders the topology around the selected node.
//   - data.active=true renders measured active flow after a successful run.
// Active flow wins visually over topology trace so result-backed signal is
// always the strongest colour on the canvas.

import React from "react";
import { EdgeProps, getStraightPath } from "reactflow";

const STROKE = "#475569";
const STROKE_ACTIVE = "#10b981";  // emerald — matches the Active dot in the Results tab
const STROKE_TRACED = "#f59e0b";  // amber — topology trace before results exist
const ARROW_SIZE = 9;   // smaller arrow to match compact node sizes
const ARROW_POS = 0.8;  // 80% from source → target (was 0.5 midpoint)

interface PywrEdgeData {
  // When true, the edge lies on a path from the selected node to a downstream
  // Output sink with non-zero recorded flow. Set by App.tsx via toRFEdges.
  active?: boolean;
  // When true, the edge is topologically reachable upstream/downstream of the
  // selected node. Works even before the model has been run.
  traced?: boolean;
}

export function PywrEdge({
  sourceX, sourceY, targetX, targetY,
  style, selected, data,
}: EdgeProps<PywrEdgeData>) {
  const [path] = getStraightPath({ sourceX, sourceY, targetX, targetY });

  const isActive = data?.active === true;
  const isTraced = data?.traced === true;
  const stroke = selected ? "#3b82f6" : isActive ? STROKE_ACTIVE : isTraced ? STROKE_TRACED : STROKE;

  // Arrow anchor point at ARROW_POS along the edge
  const ax = sourceX + ARROW_POS * (targetX - sourceX);
  const ay = sourceY + ARROW_POS * (targetY - sourceY);

  // Angle from source → target
  const angle = Math.atan2(targetY - sourceY, targetX - sourceX);
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const half = ARROW_SIZE / 2;

  // Triangle: tip points toward target, base perpendicular behind it
  const tip   = { x: ax + cos * half,              y: ay + sin * half };
  const baseL = { x: ax - cos * half + sin * half, y: ay - sin * half - cos * half };
  const baseR = { x: ax - cos * half - sin * half, y: ay - sin * half + cos * half };

  const points = `${tip.x},${tip.y} ${baseL.x},${baseL.y} ${baseR.x},${baseR.y}`;

  return (
    <>
      {/* Invisible wide hit area so right-click works on a thin line */}
      <path d={path} stroke="transparent" strokeWidth={12} fill="none" />
      {/* Visible line — active edges are slightly thicker so they read from
          across the canvas even on a dense network. */}
      <path
        d={path}
        stroke={stroke}
        strokeWidth={selected ? 2.8 : isActive ? 2.8 : isTraced ? 2.4 : 1.8}
        fill="none"
        style={style}
      />
      {/* Directional arrow triangle */}
      <polygon points={points} fill={stroke} />
    </>
  );
}

// src/utils/nodePosition.ts
// SSOT for the off-schema `position` object a Pywr node may carry.
//
// Three coordinate spaces exist across the Pywr ecosystem:
//   - position.editor_position : [x, y]  — pywr-editor (pixel coords)
//   - position.schematic       : [x, y]  — pywr core / Pywr Viewer (abstract)
//   - position.geographic      : [x, y]  — real-world lon/lat
//
// Preference order on READ (extractNodePosition): editor_position > schematic
// > geographic. This matches what every Pywr tool reads, so a file that
// round-trips through the canvas keeps the layout the user expects.
//
// On WRITE (embedNodePosition) we set BOTH editor_position and schematic to
// the same [x, y] so one JSON file opens cleanly in pywr-editor AND Pywr core.
// Existing keys (notably geographic) are preserved.
//
// This file replaces four near-identical copies of this logic that previously
// lived in App.tsx (two readers), usePywrJson.ts (one writer), and
// utils/embedPositions.ts (one writer). Keeping the preference order, the
// validity checks, and the write order in one place is the only way to keep
// reads and writes symmetric — drift caused subtle layout-loss bugs on
// reopen before this was centralised.

import type { PywrNode } from "../types/pywr";

export interface NodePos {
  x: number;
  y: number;
}

// Read a {x, y} pair from a node's position object. Returns null when no
// recognised coord space carries a valid pair. Tolerates a missing position
// field, a non-object position, and a position whose values are not the
// expected [number, number] tuple — none of those are errors, they just mean
// the node has no usable layout hint and the caller should fall back (e.g.
// auto-layout via dagre).
export function extractNodePosition(node: PywrNode): NodePos | null {
  const pos = (node as unknown as Record<string, unknown>)["position"];
  if (!pos || typeof pos !== "object" || Array.isArray(pos)) return null;
  const p = pos as Record<string, unknown>;
  for (const key of ["editor_position", "schematic", "geographic"] as const) {
    const v = p[key];
    if (
      Array.isArray(v) &&
      v.length >= 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "number"
    ) {
      return { x: v[0], y: v[1] };
    }
  }
  return null;
}

// Write {x, y} into a node's position.editor_position AND position.schematic
// (both keys, same coords) so the file is portable across pywr-editor and
// Pywr core/Viewer. Existing keys (e.g. geographic lon/lat) are preserved.
//
// Returns the same node reference when nothing actually changes — keeps
// React reconciliation cheap and lets callers (drag handlers) fire on every
// pointer-move event without triggering a re-render when the user hasn't
// moved a node by a whole pixel.
//
// Non-finite coords (NaN, Infinity) are rejected: those would write invalid
// JSON, and the only realistic source is a buggy upstream calc.
export function embedNodePosition<T extends PywrNode>(
  node: T,
  x: number,
  y: number,
): T {
  if (!Number.isFinite(x) || !Number.isFinite(y)) return node;
  const cast = node as unknown as Record<string, unknown>;
  const existing = cast.position;
  const existingObj: Record<string, unknown> =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const ep = existingObj.editor_position;
  if (Array.isArray(ep) && ep[0] === x && ep[1] === y) return node;
  const coords: [number, number] = [x, y];
  return {
    ...node,
    position: { ...existingObj, schematic: coords, editor_position: coords },
  } as unknown as T;
}

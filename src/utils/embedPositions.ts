// src/utils/embedPositions.ts
// Inject canvas node positions back into the Pywr model JSON before export
// so the file alone is portable across Pywr applications:
//
//   - Pywr core / Pywr Viewer  reads  position.schematic
//   - pywr-editor              reads  position.editor_position
//
// Writing both fields with identical [x, y] makes one JSON file open in any
// of those tools without a separate layout sidecar.
//
// The per-node write logic lives in utils/nodePosition.ts (embedNodePosition)
// so the position-key order, preserved-keys behaviour, and validity checks
// stay in sync with the reader.

import type { PywrModel } from "../types/pywr";
import { embedNodePosition, type NodePos } from "./nodePosition";

export type { NodePos };

export function embedPositions(
  model: PywrModel,
  positions: Record<string, NodePos>,
): PywrModel {
  const nodes = model.nodes.map((node) => {
    const p = positions[node.name];
    if (!p) return node;
    return embedNodePosition(node, p.x, p.y);
  });
  return { ...model, nodes };
}

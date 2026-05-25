// src/utils/cascadeDelete.ts
// Pure helpers for cascading reference removal when a node is deleted.
//
// When a node disappears from the model, three other places can hold a
// reference to its name:
//
//   1. Edges with from_node / to_node equal to the name        (always removed)
//   2. Other nodes' `nodes: string[]` / `storages: string[]`   (filtered out)
//      e.g. VirtualStorage, AggregatedNode, AggregatedStorage
//   3. Recorders whose `node` field equals the name            (recorder removed)
//
// Parameters are intentionally NOT cleaned (DECISIONS.md D-06): they're opaque
// in the type system, removal could chain-break unrelated parameters that
// reference this one, and the validation pass already surfaces dangling refs
// as warnings. Letting validation catch them is safer than guessing.

import type { PywrNode, PywrEdge, PywrRecorder } from "../types/pywr";
import { isNodeBoundRecorder } from "../types/pywr";

// Strip `deletedName` from any string-array reference fields on a node.
// Returns the same object reference when nothing changed (cheap React diffing).
export function scrubNodeRefs<T extends PywrNode>(node: T, deletedName: string): T {
  const cast = node as unknown as Record<string, unknown>;
  let changed = false;
  let next: Record<string, unknown> | null = null;

  for (const key of ["nodes", "storages"] as const) {
    const v = cast[key];
    if (!Array.isArray(v)) continue;
    if (!v.every((x) => typeof x === "string")) continue;
    const filtered = (v as string[]).filter((n) => n !== deletedName);
    if (filtered.length === v.length) continue;
    if (!next) next = { ...cast };
    next[key] = filtered;
    changed = true;
  }

  return changed ? (next as T) : node;
}

// Drop edges that touch the deleted node on either end.
// Edges are tuples [from, to, ...slots] — index 0 and 1 are the endpoints.
export function filterEdgesForNode(
  edges: readonly PywrEdge[],
  deletedName: string,
): PywrEdge[] {
  return edges.filter((e) => e[0] !== deletedName && e[1] !== deletedName);
}

// Drop recorders whose `node` field equals the deleted name.
// Recorders that reference the node only via `param`, or whose type isn't
// node-bound at all, are kept untouched. The narrowing happens in
// isNodeBoundRecorder so an unrecognised recorder shape (UnknownRecorder)
// with a stray `node: "foo"` is also handled — we still drop it if the type
// tag puts it in the node-bound set.
export function filterRecordersForNode(
  recorders: Record<string, PywrRecorder>,
  deletedName: string,
): Record<string, PywrRecorder> {
  const out: Record<string, PywrRecorder> = {};
  for (const [key, rec] of Object.entries(recorders)) {
    if (isNodeBoundRecorder(rec) && rec.node === deletedName) continue;
    out[key] = rec;
  }
  return out;
}

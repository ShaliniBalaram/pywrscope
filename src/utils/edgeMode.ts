// src/utils/edgeMode.ts
// Pure state machine for "Add Edge" mode. Single source of truth for the
// click-source / click-target / cancel transitions — keeps App.tsx free of
// inline branching and gives the behaviour a unit-testable shape.
//
// Transitions:
//   no source        + click X       →  pickSource(X)
//   source = X       + click X       →  cancelSource         (same node = abort)
//   source = X       + click Y       →  connect(X, Y)        (caller exits mode)

export type EdgeStep =
  | { kind: "pickSource"; source: string }
  | { kind: "cancelSource" }
  | { kind: "connect"; from: string; to: string };

export function nextEdgeStep(
  currentSource: string | null,
  clickedName: string,
): EdgeStep {
  if (currentSource === null) return { kind: "pickSource", source: clickedName };
  if (currentSource === clickedName) return { kind: "cancelSource" };
  return { kind: "connect", from: currentSource, to: clickedName };
}

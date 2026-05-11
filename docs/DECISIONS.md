# DECISIONS.md — Architectural Decisions

Records significant design decisions made for Pywrscope and the reasoning behind them.

---

## D-01: No backend server

**Decision:** All model logic (parse, validate, export, add-recorders) runs in Rust inside
the Tauri process. No Python backend, no Flask, no HTTP server, no ports.

**Reason:** The original Flask backend only did JSON manipulation and schema validation —
nothing that required Python specifically. Moving it to Rust eliminates the cold-start
delay, removes Python as a user prerequisite, and shrinks the installer significantly.

---

## D-02: Positions embedded in model JSON; sidecar holds background only

**Decision:** On export, every node receives `position.schematic: [x, y]` and
`position.editor_position: [x, y]` derived from canvas layout. The
`<model_name>.layout.json` sidecar is still written, but only as a cache for
background image + opacity (and as a fallback for older files).

**Reason:** The whole point of this tool is to give Pywr models a layout that
travels with the file. The earlier version of D-02 claimed embedding coordinates
would "make it non-standard"; that was wrong. `position.schematic` is the field
Pywr core / Pywr Viewer reads, and `position.editor_position` is what
pywr-editor reads — both are part of the Pywr ecosystem schema. Writing both
fields with identical `[x, y]` makes a single JSON file open correctly in any
Pywr application without a sidecar.

**Implementation:** `src/utils/embedPositions.ts` is a pure helper called from
both `handleSave` and `performSave` in `App.tsx`, immediately before
`/api/export`. Existing position keys (e.g. `geographic` lon/lat) are preserved.

---

## D-03: Tauri v2 + React + Rust

**Decision:** Tauri for the desktop shell, React for the UI, Rust for all editor logic.

**Reason:** React Flow is the best available drag-and-drop graph editor for React.
PyQt/Tkinter equivalents are significantly more limited. Tauri v2 produces smaller
installers than Electron (~5MB vs ~150MB) and uses the OS WebView rather than bundling
Chromium. All model logic in Rust gives fast, reliable JSON processing.

---

## D-04: Immutable state updates in React hooks

**Decision:** All model mutations in `usePywrJson.ts` produce new objects via spread.
No direct mutation of state.

**Reason:** React requires immutable updates for re-renders to work correctly.

---

## D-05: Cascade delete is atomic; undo works

**Decision:** Deleting a node removes the node, all touching edges, dependent
recorders (those whose `node` field equals the deleted name), and the deleted
name from any `nodes` / `storages` arrays on remaining nodes — all in one
`setModel` call, producing one history snapshot.

**Reason:** A single atomic removal means one ⌘Z undoes the whole thing.
Earlier the dialog called `removeNode` then iterated `removeEdge` per touching
edge, producing N history entries; this also let inconsistent intermediate
states leak. Cascade lives in `pywrJson.removeNode` (SSOT) so every code path
that removes a node — single dialog, batch dialog, any future caller — gets
the same behaviour without remembering to clean up.

**Parameters are intentionally NOT cascade-cleaned** (they remain raw JSON,
per D-06): a parameter can reference the deleted node in many opaque ways and
removing the parameter could break unrelated parameters that reference it.
The validation pass already surfaces dangling refs as warnings.

**Implementation:** `src/utils/cascadeDelete.ts` exposes pure helpers
(`scrubNodeRefs`, `filterEdgesForNode`, `filterRecordersForNode`).
`usePywrJson.removeNode` calls all three inside one `setModel` block.

---

## D-06: Parameters and recorders left as raw JSON

**Decision:** The app does not provide a UI for creating or editing parameters, recorders,
or tables. Users edit these directly in the JSON tab.

**Reason:** PyWR parameter types are numerous and highly variable (CSVParameter,
MonthlyProfileParameter, AggregatedParameter, ADO/PDO licences, grouped licences, etc).
Building a generic UI for all variations would be enormous scope and still miss edge cases.
The JSON tab with Monaco editor gives engineers full control without abstraction overhead.

---

## D-07: Node colours defined in nodeTypes.ts only

**Decision:** Node colours are never hardcoded inline in component files.
Always read from `NODE_COLOUR_MAP` in `src/constants/nodeTypes.ts`.

**Reason:** Consistency — one place to change a colour.

---

## D-08: Absolute paths only

**Decision:** All file paths passed to Rust commands must be absolute. Relative paths are rejected.

**Reason:** The Tauri backend and the WebView renderer have different working directories.
Absolute paths are unambiguous regardless of where either process was started.

---

## D-09: Background image follows viewport transform

**Decision:** The background map image is rendered with `useViewport()` so it pans and
zooms in sync with the ReactFlow canvas nodes.

**Reason:** The primary use case is tracing a network schematic from a map image.
If the image stayed fixed while nodes zoom, the reference would be useless at any
zoom level other than 1:1.

---

## D-10: tauri_bridge.ts keeps window.pywr surface stable

**Decision:** All Tauri `invoke()` calls are centralised in `src/tauri_bridge.ts`.
No component or hook calls `invoke()` directly.

**Reason:** Keeps the React code independent of the IPC mechanism. If a command is
renamed or restructured in Rust, only `tauri_bridge.ts` needs to change.

---

## D-11: Edges stored as Pywr-canonical arrays

**Decision:** Edges are tuples in TypeScript and arrays on disk:
`["from", "to"]` or `["from", "to", from_slot, to_slot]`. Both the in-memory
shape and the exported JSON use this format. The legacy object form
`{from_node, to_node}` is still accepted on import for backwards compatibility
with files saved by Pywrscope <= v1.5.x.

**Reason:** Pywr core (`pywr.model.Model.load`) expects array-form edges. Until
v1.6.0 the canvas stored edges as objects internally and emitted that shape on
save, which meant canvas-saved JSON would not load in Pywr core directly. The
Rust parser had been silently re-emitting whatever it received, so files
round-tripped through the canvas turned into non-canonical Pywr.

The fix mirrors D-02: in-memory representation matches on-disk representation,
and the JSON tab shows what gets saved. The PywrEdge type
(`src/types/pywr.ts`) is now `readonly [string, string]
| readonly [string, string, PywrEdgeSlot, PywrEdgeSlot]`. A small Rust helper
`edge_from_to()` reads either shape so validators handle legacy and canonical
input uniformly. `parse_model` normalises any incoming object-form edges to
arrays before handing the model to React.

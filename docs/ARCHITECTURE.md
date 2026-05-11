# ARCHITECTURE.md — Pywrscope

## Overview

Pywrscope is a Tauri v2 desktop app. All model logic (parse, validate, export,
add-recorders) runs in Rust inside the Tauri backend process. There is no Python backend,
no HTTP server, and no external ports.

```
┌─────────────────────────────────────────────────┐
│  Tauri v2 (Rust)  — src-tauri/src/lib.rs         │
│                                                  │
│  parse_model          — reads + parses JSON      │
│  validate_model_cmd   — validation rules         │
│  add_recorders_cmd    — recorder injection       │
│  export_model         — validates + writes JSON  │
│  open_file_dialog     — native file picker       │
│  save_file_dialog     — native save dialog       │
│  save_layout_file     — writes .layout.json      │
│  read_layout_file     — reads .layout.json       │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │  React renderer (Vite / TypeScript)        │  │
│  │                                            │  │
│  │  src/App.tsx            — root             │  │
│  │  src/tauri_bridge.ts    — invoke() bridge  │  │
│  │  src/hooks/             — state            │  │
│  │  src/components/        — UI               │  │
│  │  src/types/pywr.ts      — types            │  │
│  │  src/constants/         — node config      │  │
│  └────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────┘
```

---

## Tauri command API

The renderer calls `window.pywr.*` methods defined in `src/tauri_bridge.ts`.
These forward to Rust `#[tauri::command]` functions via `invoke()`.
There is no HTTP server — calls are direct IPC over the Tauri runtime.

| window.pywr method | Rust command | What it does |
|--------------------|--------------|--------------|
| `openFile()` | `open_file_dialog` | Native file picker → absolute path |
| `openImage()` | `open_image_dialog` | Native file picker → asset:// URL |
| `saveFile(path)` | `save_file_dialog` | Native save dialog → chosen path |
| `openCsv()` | `open_csv_dialog` | Native file picker → absolute path |
| `readCsvColumns(path)` | `read_csv_columns` | Reads first CSV row → column names |
| `callApi(route, body)` | (dispatched below) | Routes to the appropriate Rust command |
| `saveLayoutFile(path, content)` | `save_layout_file` | Writes `.layout.json` sidecar |
| `readLayoutFile(path)` | `read_layout_file` | Reads `.layout.json` sidecar |
| `quit()` | `quit_app` | Force-quits the app |

---

## API routes (handled in Rust, not HTTP)

All routes use the same request/response shape:
- Success: `{ ok: true, data: ... }`
- Failure: `{ ok: false, error: "..." }`

### /api/parse → `parse_model`
```
Input:  { json_path: "/absolute/path/model.json" }
Output: { ok: true, data: { nodes, edges, parameters, recorders, timestepper, metadata } }
```
Reads and parses a Pywr JSON file from disk.
Normalises edges: accepts both object `{"from_node","to_node"}` and array `["from","to"]` formats.

### /api/validate → `validate_model_cmd`
```
Input:  { model: { ...full pywr model... } }
Output: { ok: true, data: { warnings: [...], errors: [...] } }
```
Validates the in-memory model. Checks: unconnected nodes, missing required fields,
invalid node types, duplicate names, orphaned edges, unreachable demands.

### /api/add-recorders → `add_recorders_cmd`
```
Input:  { model: { ...full pywr model... } }
Output: { ok: true, data: { model: {...}, added: [...] } }
```
Adds NumpyArray recorders to nodes that lack one. Does not write to disk.

### /api/export → `export_model`
```
Input:  { model: { ...full pywr model... }, output_path: "/absolute/path/..." }
Output: { ok: true, data: { written_to: "/absolute/path/..." } }
```
Validates the model, then writes Pywr JSON to disk. Blocks on errors.

---

## Data flow

```
User opens file
  → window.pywr.openFile()              [native dialog → absolute path]
  → window.pywr.callApi('/api/parse')   [Rust reads + parses JSON]
  → usePywrJson stores model in React state
  → useLayout reads .layout.json sidecar (node positions)
  → Canvas renders from React state

User edits node on canvas
  → usePywrJson.updateNode()            [updates React state]
  → ValidationBar re-validates automatically

User edits JSON tab
  → JsonEditor shows full model JSON in Monaco
  → "Apply Changes" → usePywrJson.replaceModel() [full model swap]

User saves
  → window.pywr.callApi('/api/export')  [Rust validates + writes model.json]
  → useLayout.saveLayout()              [writes .layout.json sidecar]
```

---

## Key files

| File | Role |
|------|------|
| `src-tauri/src/lib.rs` | All Rust commands: parse, validate, export, file I/O |
| `src/tauri_bridge.ts` | Installs `window.pywr` via Tauri `invoke()` |
| `src/App.tsx` | Root component, wires all hooks and tabs |
| `src/hooks/usePywrJson.ts` | Model state management |
| `src/hooks/useLayout.ts` | Node positions, background image, layout sidecar |
| `src/components/Canvas.tsx` | ReactFlow canvas with viewport-synced background image |
| `src/components/JsonEditor.tsx` | Monaco JSON editor for parameters/recorders/tables |
| `src/components/PropertiesPanel.tsx` | Node field editor with CSV linking |
| `src/types/pywr.ts` | TypeScript interfaces for all Pywr node types |
| `src/constants/nodeTypes.ts` | Node colours, shapes, labels, defaults |

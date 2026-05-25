# End-to-End Manual Test Checklist — PyWR Canvas

Run these steps in order on a freshly started application.

---

## Setup

- [ ] `npm install` completed without errors
- [ ] `npm run dev` opens the Electron window with title "PyWR Canvas"

---

## 1 — Opening a model

- [ ] Click **Open** → native file picker appears
- [ ] Navigate to `python/tests/fixtures/minimal_model.json` → click Open
- [ ] Canvas shows 3 nodes: Bordon_GW, Bordon_WTW, Bordon_DC
- [ ] Two edges are drawn: GW→WTW and WTW→DC
- [ ] ValidationBar shows 0 errors within 1.5 seconds
- [ ] ValidationBar shows NO_RECORDER warnings for all 3 nodes (no recorders in fixture)

---

## 2 — Node selection and properties

- [ ] Click on **Bordon_GW** → Properties panel opens on the right
- [ ] Properties panel shows Name: Bordon_GW (read-only), Type: Input (read-only)
- [ ] Max Flow field shows 5 (from the fixture)
- [ ] Change Max Flow to `abc` → inline error "Must be a number" appears; model is NOT updated
- [ ] Change Max Flow to `7.5` → tab/click away → model updates (toolbar shows "Save *")
- [ ] Click empty canvas → properties panel closes

---

## 3 — Drag-and-drop new node

- [ ] Drag "Input" tile from the Sources group to an empty area of the canvas
- [ ] New node "Input" appears at the drop position
- [ ] Drag "Input" tile again → new node named "Input_2" appears (not duplicate)
- [ ] ValidationBar shows UNCONNECTED_NODE warnings for the new nodes
- [ ] Toolbar shows "Save *" (model is dirty)

---

## 4 — Delete node (smart delete dialog)

- [ ] Click on **Bordon_WTW** to select it
- [ ] Press the Delete key
- [ ] Delete dialog appears showing upstream and downstream nodes
- [ ] Choose "Connect each upstream node directly to each downstream node"
- [ ] Click Confirm Delete
- [ ] Bordon_WTW is removed from canvas
- [ ] Edge Bordon_GW → Bordon_DC is present
- [ ] ValidationBar updates within 1.5s

---

## 5 — Background map image

- [ ] Click **Load Map** → native file picker appears (filters to PNG/JPG)
- [ ] Select any PNG or JPG image
- [ ] Image appears behind the network nodes and pans/zooms with the canvas
- [ ] Opacity slider appears in toolbar
- [ ] Move slider left → image nearly invisible; move right → clearly visible

---

## 6 — Grid snap

- [ ] Click **Snap** in the toolbar → button highlights
- [ ] Drag a node → it snaps to grid increments
- [ ] Change the grid size input → snap increments change accordingly
- [ ] Click **🔒** → grid size input becomes disabled (locked)
- [ ] Click **🔒** again → grid unlocks

---

## 7 — JSON tab

- [ ] Click the **JSON** tab in the tab bar
- [ ] Full model JSON appears in the Monaco editor
- [ ] Edit a value (e.g. change a node name) — "Unsaved changes" label appears
- [ ] Click **Apply Changes** → canvas updates
- [ ] Introduce a syntax error (e.g. delete a `{`) → red error bar appears, Apply is disabled
- [ ] Fix the error → Apply re-enables
- [ ] Click **Discard** → editor reverts to canvas model

---

## 8 — CSV parameter linking

- [ ] Open a model, click a node to select it
- [ ] In the Properties panel, click **📎** next to Max Flow
- [ ] Native CSV file picker appears
- [ ] Select a CSV file → column dropdown appears
- [ ] Choose a column and click **Link**
- [ ] Max Flow field now shows the parameter name (e.g. `NodeName__max_flow`)
- [ ] Switch to the JSON tab → `parameters` section contains a `CSVParameter` entry

---

## 9 — Save and reload

- [ ] Click **Save** → native save dialog appears
- [ ] Save to `test_output.json`
- [ ] Toolbar shows "Save" (no asterisk)
- [ ] Check that `test_output.layout.json` was created alongside `test_output.json`
- [ ] Open `test_output.json` → model reloads with correct nodes/edges
- [ ] Node positions match what was on screen before saving

---

## 10 — Validation bar interaction

- [ ] Open `minimal_model.json`
- [ ] ValidationBar shows NO_RECORDER warnings for all nodes
- [ ] Click a warning pill → that node is highlighted (gold outline) for ~2 seconds

---

## 11 — Type check

```bash
npx tsc --noEmit
```

- [ ] Zero TypeScript errors

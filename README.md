# Pywrscope

A desktop tool for water engineers to open, edit and validate Pywr water resource model files on an interactive map canvas.

---

## Installation

Download the installer for your platform from the [Releases](https://github.com/ShaliniBalaram/pywrscope/releases) page.

| Platform | File to download |
|----------|-----------------|
| **Mac — Apple Silicon (M1/M2/M3)** | `PyWR.Canvas_1.4.4_aarch64.dmg` |
| **Mac — Intel** | `PyWR.Canvas_1.4.4_x64.dmg` |
| **Windows** | `PyWR.Canvas_1.4.4_x64-setup.exe` |
| **Linux (Ubuntu/Debian)** | `PyWR.Canvas_1.4.4_amd64.deb` |
| **Linux (other)** | `PyWR.Canvas_1.4.4_amd64.AppImage` |

---

### Mac — first-time setup (one-time step)

Because the app is not signed with an Apple certificate, macOS will block it on first open. This is a standard warning for free/open-source apps and is safe to bypass.

**Step 1** — Open the `.dmg` and drag Pywrscope to your Applications folder as normal.

**Step 2** — Open Terminal (press Cmd+Space and search "Terminal") and run:

```
xattr -cr /Applications/PyWR\ Canvas.app
```

**Step 3** — Double-click the app. It will open normally from now on — you never need to do this again.

> If you see "Apple cannot check it for malicious software" — this is the same fix. Run the command above and the message will not appear again.

---

### Windows — first-time setup

Windows may show a SmartScreen warning ("Windows protected your PC"). This is normal for unsigned apps.

1. Click **More info**
2. Click **Run anyway**

---

### Linux

For `.deb`: double-click or run `sudo dpkg -i pywrscope_*.deb`

For `.AppImage`: make it executable first:
```
chmod +x pywrscope_*.AppImage
./pywrscope_*.AppImage
```

---

## How to Use

### Creating a new model from scratch
1. Click **✦ New** in the toolbar (or press Cmd+N / Ctrl+N)
2. Optionally click **Map** to load a background image (river map, satellite image, etc.)
3. Drag node types from the left panel onto the canvas
4. Use **Add Edge** to connect nodes
5. Click **Save** to export as a `.json` file

### Opening an existing model
1. Click **Open** in the toolbar (or press Cmd+O / Ctrl+O)
2. Select your Pywr `.json` model file
3. Your network appears on the canvas, arranged by network topology

### Recent files
Click the **🕐** dropdown next to Open to reopen any of your last 8 files instantly.

### Moving nodes
- Click and drag any node to reposition it
- Enable **Snap** in the toolbar to snap to a grid
- Positions are saved when you save the model

### Selecting nodes
- Click a node to select it
- Shift+click to add/remove from selection
- Click empty canvas to deselect

### Editing a node
1. Click on a node to select it
2. The **Properties** panel opens on the right
3. Edit the name, type, or any field — changes apply immediately

### Renaming a node
- Double-click the node on the canvas to rename it inline, or
- Edit the **name** field in the Properties panel

### Adding nodes
- Drag a node type from the left palette onto the canvas, or
- Click **＋ Add Node** in the toolbar

### Connecting nodes
1. Click **⟶ Add Edge** in the toolbar
2. Click the source node
3. Click the target node
4. Right-click an edge to delete it

### Auto-arranging the layout
Click **⟁ Layout** in the toolbar to automatically arrange all nodes left-to-right by network topology (sources → links → outputs). Useful after adding many nodes.

### Searching for a node
- Click **🔍 Find** or press Cmd+F / Ctrl+F
- Type to filter, use arrow keys to navigate, press Enter to zoom to the node

### Labels
Click **🏷 Labels** to toggle node name labels on/off.

### Zoom to selection
Select one or more nodes, then press Cmd+Shift+F or click **⛶ Fit** to zoom the canvas to them.

### Copy and paste nodes
- Select nodes and press Cmd+C / Ctrl+C to copy
- Press Cmd+V / Ctrl+V to paste (nodes appear offset from the originals)

### Deleting nodes
- Right-click a node to delete it (a dialog shows connected nodes)
- Select multiple nodes and press Delete to batch delete

### Undo / Redo
- Cmd+Z / Ctrl+Z to undo
- Cmd+Shift+Z / Ctrl+Shift+Z to redo

### Background map image
1. Click **Map** in the toolbar
2. Select a PNG or JPG (river maps, satellite imagery, GIS exports)
3. Use the **Opacity** slider to adjust transparency
4. Enable **Snap** and set the grid size to match the map scale
5. Click **Lock** to lock the grid

### Editing JSON directly
1. Open the **JSON** tab in the tab bar
2. Edit the full model — parameters, recorders, timestepper, etc.
3. Click **Apply Changes** to push your edits to the canvas

### Linking a CSV file to a node field
1. Click a node to select it
2. In the Properties panel, click the **paperclip** icon next to any flow or volume field
3. Select your CSV and choose the column
4. A `CSVParameter` entry is created automatically in the model

### Checking for errors
The bar at the bottom shows validation results automatically:
- **Red** = errors that must be fixed
- **Amber** = warnings (the model will still save)
- Click any message to highlight the problem node

### Saving
- Click **Save** or press Cmd+S / Ctrl+S
- Two files are written: your `.json` model and a `.layout.json` sidecar that remembers node positions and background image

### Exporting as PNG
Click **🖼 Export** to save the current canvas as a PNG image.

### Status bar
The bar at the very bottom shows:
- File name (yellow dot = unsaved changes)
- Total node and edge counts
- Breakdown by type: Sources / Demands / Storage / Links
- Number of selected nodes

### Running a model
Pywrscope ships its own Python interpreter and `pywr` install — you don't need Python on your machine.

1. Open or create a model and **save it to disk** (Cmd+S / Ctrl+S). The Run button stays disabled until the file is saved and clean.
2. Click **▶ Run** in the toolbar.
3. A progress panel appears at the bottom-right with live step counts and date. Click **Cancel** to stop.
4. On success, a results folder is created next to your model file: `<model>.results/`. It contains `summary.json` (machine-readable) and one CSV per recorder.
5. On failure, the panel shows a typed error code and a collapsible Python traceback. Common codes:
   - **MODEL_LOAD_FAILED** — Pywr could not parse your JSON. Check that all parameter references resolve and required fields are present.
   - **SOLVER_ERROR** — Pywr ran but a timestep was infeasible. Check capacity / cost configurations.
   - **PYWR_IMPORT_FAILED** — the bundled Python is broken; reinstall the app.

---

## Keyboard shortcuts

| Action | Mac | Windows/Linux |
|--------|-----|---------------|
| New model | Cmd+N | Ctrl+N |
| Open | Cmd+O | Ctrl+O |
| Save | Cmd+S | Ctrl+S |
| Undo | Cmd+Z | Ctrl+Z |
| Redo | Cmd+Shift+Z | Ctrl+Shift+Z |
| Find node | Cmd+F | Ctrl+F |
| Zoom to selection | Cmd+Shift+F | Ctrl+Shift+F |
| Copy nodes | Cmd+C | Ctrl+C |
| Paste nodes | Cmd+V | Ctrl+V |
| Cancel / close | Esc | Esc |

---

## Troubleshooting

**"Apple cannot check it for malicious software" (Mac)**
Run this in Terminal:
```
xattr -cr /Applications/PyWR\ Canvas.app
```
Then open the app normally.

**"Windows protected your PC" (Windows)**
Click **More info** then **Run anyway**. This is a one-time warning.

**Nodes appear on top of each other when opening a file**
No layout file exists yet. Click **⟁ Layout** to auto-arrange, then save.

**The model opens but looks wrong after editing the JSON tab**
Click **Apply Changes** after every edit in the JSON tab for changes to take effect.

**The Run button is greyed out**
Three reasons (in priority order): (1) no model open, (2) the model has never been saved to disk, (3) you have unsaved edits. Save first, then run. The tooltip on the disabled button tells you which case applies.

**"Bundled python-runtime not found" when clicking Run**
The runtime is downloaded at build time, not committed to the repo. From a fresh checkout, run `npm run setup:python` once before `npm run dev` or `npm run build`. The `dev` and `build` scripts also run this automatically — but if you cancelled the first run mid-download, re-run it.

---

## Development

```bash
npm install
npm run setup:python   # one-time: ~100 MB download, installs Pywr
npm run dev            # launches Tauri dev shell
npm test               # vitest (frontend)
npm run test:integration  # bash + python event-protocol checks
cargo test --manifest-path src-tauri/Cargo.toml --lib   # Rust tests
```

The Python runtime is pinned in `scripts/setup-python-runtime.sh` (`python-build-standalone` release tag, Python version, Pywr version). Bumping any of those forces a clean rebuild on the next setup invocation via the `.runtime-version` marker file. The runtime itself lives at `src-tauri/resources/python-runtime/` and is gitignored — it's a reproducible build artefact, not source.

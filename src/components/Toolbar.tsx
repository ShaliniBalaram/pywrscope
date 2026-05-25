import React from "react";

interface ToolbarProps {
  hasModel: boolean;
  isDirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
  backgroundOpacity: number;
  backgroundImage: string | null;
  gridSize: number;
  gridSnap: boolean;
  gridLocked: boolean;
  hasSelection: boolean;
  onNew: () => void;
  onOpen: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onAddNode: () => void;
  onAddEdge: () => void;
  edgeMode: boolean;
  onDelete: () => void;
  // What the Delete button will act on:
  //   "none"   → no selection, button disabled
  //   "node"   → 1 node selected
  //   "nodes"  → 2+ nodes selected (batch)
  //   "edge"   → 1 edge selected
  deleteSelection: "none" | "node" | "nodes" | "edge";
  onLoadImage: () => void;
  onOpacityChange: (opacity: number) => void;
  onGridSizeChange: (size: number) => void;
  onGridSnapToggle: () => void;
  onGridLockToggle: () => void;
  showLabels: boolean;
  onToggleLabels: () => void;
  onSearch: () => void;
  onZoomToSelection: () => void;
  onExportPng: () => void;
  recentFiles: string[];
  onOpenRecent: (path: string) => void;
  onAutoLayout: () => void;
  // Run button: enabled iff a model is open AND saved on disk AND not dirty AND
  // no run is currently active. The Run flow needs an absolute path to feed
  // pywr.Model.load(); a dirty-but-on-disk model would silently run the
  // last-saved version, which is a footgun.
  onRun: () => void;
  runDisabledReason: string | null;
}

export function Toolbar({
  hasModel, isDirty, canUndo, canRedo,
  backgroundOpacity, backgroundImage,
  gridSize, gridSnap, gridLocked, hasSelection,
  onNew, onOpen, onSave, onUndo, onRedo, onAddNode, onAddEdge, edgeMode, onLoadImage,
  onDelete, deleteSelection,
  onOpacityChange, onGridSizeChange, onGridSnapToggle, onGridLockToggle,
  showLabels, onToggleLabels, onSearch, onZoomToSelection, onExportPng,
  recentFiles, onOpenRecent, onAutoLayout,
  onRun, runDisabledReason,
}: ToolbarProps) {
  const deleteLabel =
    deleteSelection === "edge" ? "Delete edge"
    : deleteSelection === "nodes" ? "Delete nodes"
    : "Delete";
  const deleteTitle =
    deleteSelection === "none" ? "Select a node or edge first"
    : deleteSelection === "edge" ? "Delete the selected edge (Del)"
    : deleteSelection === "nodes" ? "Delete selected nodes (Del)"
    : "Delete selected node (Del)";
  return (
    <div style={{
      height: 48, backgroundColor: "#111827",
      display: "flex", alignItems: "center",
      padding: "0 14px", gap: 6, flexShrink: 0, userSelect: "none",
      borderBottom: "1px solid #1f2937",
    }}>
      {/* Logo / title */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginRight: 8 }}>
        <div style={{
          width: 24, height: 24, borderRadius: 6,
          background: "linear-gradient(135deg, #3B8BD4 0%, #1D9E75 100%)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 13, color: "#fff", fontWeight: "bold",
        }}>P</div>
        <span style={{ color: "#f9fafb", fontWeight: 700, fontSize: 13, letterSpacing: "-0.01em" }}>
          PywrScope
        </span>
      </div>

      <Divider />

      <Btn onClick={onNew} title="New blank model (⌘N)">✦ New</Btn>
      <Btn onClick={onOpen} title="Open model (⌘O)">📂 Open</Btn>
      {recentFiles.length > 0 && <RecentFilesDropdown files={recentFiles} onOpen={onOpenRecent} />}
      <Btn onClick={onSave} disabled={!hasModel} highlight={isDirty} title="Save model (⌘S)">
        💾 {isDirty ? "Save *" : "Save"}
      </Btn>

      <Divider />

      <Btn onClick={onUndo} disabled={!canUndo} title="Undo (⌘Z)">↩</Btn>
      <Btn onClick={onRedo} disabled={!canRedo} title="Redo (⌘⇧Z)">↪</Btn>

      <Divider />

      <Btn onClick={onAddNode} disabled={!hasModel} accent title="Add node to canvas">＋ Add Node</Btn>
      <Btn onClick={onAddEdge} disabled={!hasModel} active={edgeMode} title="Add edge — click source then target node">⟶ Add Edge</Btn>
      <Btn onClick={onDelete} disabled={deleteSelection === "none"} title={deleteTitle}>🗑 {deleteLabel}</Btn>

      <Divider />

      <Btn
        onClick={onRun}
        disabled={runDisabledReason !== null}
        accent
        title={runDisabledReason ?? "Run the Pywr model (saved file required)"}
      >
        ▶ Run
      </Btn>

      <Divider />

      <Btn onClick={onToggleLabels} disabled={!hasModel} active={showLabels} title="Toggle node labels">🏷 Labels</Btn>
      <Btn onClick={onSearch} disabled={!hasModel} title="Find node (⌘F)">🔍 Find</Btn>
      <Btn onClick={onZoomToSelection} disabled={!hasSelection} title="Zoom to selected nodes (⌘⇧F)">⛶ Fit</Btn>
      <Btn onClick={onAutoLayout} disabled={!hasModel} title="Auto-arrange nodes using network topology">⟁ Layout</Btn>
      <Btn onClick={onExportPng} disabled={!hasModel} title="Export canvas as PNG">🖼 Export</Btn>

      <Divider />

      <Btn onClick={onLoadImage} disabled={!hasModel} title="Load background map image">🗺 Map</Btn>

      {backgroundImage && (
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ color: "#9ca3af", fontSize: 11 }}>Opacity</span>
          <input
            type="range" min={0.1} max={0.9} step={0.05}
            value={backgroundOpacity}
            onChange={e => onOpacityChange(parseFloat(e.target.value))}
            style={{ width: 70, cursor: "pointer", accentColor: "#3B8BD4" }}
          />
          <span style={{ color: "#6b7280", fontSize: 11, minWidth: 26 }}>
            {Math.round(backgroundOpacity * 100)}%
          </span>
        </div>
      )}

      <Divider />

      <Btn onClick={onGridSnapToggle} disabled={!hasModel} active={gridSnap} title="Snap to grid">
        ⊞ Snap
      </Btn>

      {gridSnap && (
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <input
            type="number" min={5} max={200} step={5}
            value={gridSize} disabled={gridLocked}
            onChange={e => { const v = parseInt(e.target.value, 10); if (!isNaN(v) && v >= 5 && v <= 200) onGridSizeChange(v); }}
            style={{
              width: 44, fontSize: 11, padding: "2px 4px", borderRadius: 4,
              border: "1px solid #374151", backgroundColor: "#1f2937",
              color: gridLocked ? "#6b7280" : "#e5e7eb", textAlign: "center",
            }}
          />
          <span style={{ color: "#6b7280", fontSize: 11 }}>px</span>
          <Btn onClick={onGridLockToggle} active={gridLocked} title={gridLocked ? "Unlock grid" : "Lock grid"}>
            {gridLocked ? "🔒" : "🔓"}
          </Btn>
        </div>
      )}
    </div>
  );
}

function Divider() {
  return <div style={{ width: 1, height: 22, backgroundColor: "#374151", margin: "0 2px" }} />;
}

interface BtnProps {
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  highlight?: boolean;
  active?: boolean;
  accent?: boolean;
  children: React.ReactNode;
}

function Btn({ onClick, disabled, title, highlight, active, accent, children }: BtnProps) {
  const bg = highlight ? "#b45309"
    : accent ? "#1d4ed8"
    : active ? "#1e3a5f"
    : "#1f2937";
  const hoverBg = highlight ? "#d97706" : accent ? "#2563eb" : active ? "#1e40af" : "#374151";
  const [hovered, setHovered] = React.useState(false);
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        backgroundColor: hovered && !disabled ? hoverBg : bg,
        color: disabled ? "#4b5563" : "#e5e7eb",
        border: "none", borderRadius: 6,
        padding: "4px 10px", fontSize: 12,
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background-color 0.12s",
        whiteSpace: "nowrap",
        fontFamily: "sans-serif",
      }}
    >
      {children}
    </button>
  );
}

function RecentFilesDropdown({ files, onOpen }: { files: string[]; onOpen: (path: string) => void }) {
  const [open, setOpen] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(o => !o)}
        title="Recent files"
        style={{
          backgroundColor: open ? "#374151" : "#1f2937",
          color: "#e5e7eb", border: "none", borderRadius: 6,
          padding: "4px 8px", fontSize: 12, cursor: "pointer",
          transition: "background-color 0.12s", fontFamily: "sans-serif",
          display: "flex", alignItems: "center", gap: 4,
        }}
      >
        🕐 <span style={{ fontSize: 10, color: "#9ca3af" }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 200,
          backgroundColor: "#1f2937", border: "1px solid #374151",
          borderRadius: 6, minWidth: 280, boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
          overflow: "hidden",
        }}>
          {files.map((path) => {
            const name = path.split(/[\\/]/).pop() ?? path;
            const dir = path.split(/[\\/]/).slice(0, -1).join("/");
            return (
              <button
                key={path}
                onClick={() => { onOpen(path); setOpen(false); }}
                style={{
                  display: "block", width: "100%", textAlign: "left",
                  backgroundColor: "transparent", border: "none",
                  padding: "7px 12px", cursor: "pointer", color: "#e5e7eb",
                  fontSize: 12, fontFamily: "sans-serif",
                  borderBottom: "1px solid #374151",
                }}
                onMouseEnter={e => (e.currentTarget.style.backgroundColor = "#374151")}
                onMouseLeave={e => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                <div style={{ fontWeight: 500, marginBottom: 1 }}>{name}</div>
                <div style={{ fontSize: 10, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{dir}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// src/components/SaveBeforeCloseDialog.tsx
// Modal shown when the user tries to close with unsaved changes.
// Offers Save (with optional rename), Don't Save, and Cancel.

import React, { useState } from "react";

interface SaveBeforeCloseDialogProps {
  currentPath: string | null;
  onSave: (proposedPath: string) => Promise<boolean>; // returns true if saved
  onDiscard: () => void;
  onCancel: () => void;
}

export function SaveBeforeCloseDialog({
  currentPath,
  onSave,
  onDiscard,
  onCancel,
}: SaveBeforeCloseDialogProps) {
  const defaultName = currentPath
    ? currentPath.split(/[\\/]/).pop() ?? "model.json"
    : "model.json";

  const [fileName, setFileName] = useState(defaultName);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    // Build a proposed full path: same directory as currentPath but with new filename
    let proposed = fileName.trim() || defaultName;
    if (!proposed.endsWith(".json")) proposed += ".json";
    if (currentPath) {
      const dir = currentPath.substring(0, currentPath.lastIndexOf("/") + 1) ||
                  currentPath.substring(0, currentPath.lastIndexOf("\\") + 1);
      proposed = dir + proposed;
    }
    const saved = await onSave(proposed);
    if (!saved) setSaving(false); // user cancelled the native dialog — stay open
  }

  return (
    <div style={overlayStyle}>
      <div style={dialogStyle}>
        <h3 style={{ margin: "0 0 8px", fontSize: 15, color: "#2c3e50" }}>
          Unsaved changes
        </h3>
        <p style={{ margin: "0 0 16px", fontSize: 13, color: "#555" }}>
          Do you want to save before closing?
        </p>

        <label style={{ fontSize: 12, color: "#666", display: "block", marginBottom: 4 }}>
          Save as:
        </label>
        <input
          type="text"
          value={fileName}
          onChange={(e) => setFileName(e.target.value)}
          disabled={saving}
          style={{
            width: "100%",
            boxSizing: "border-box",
            padding: "6px 8px",
            fontSize: 13,
            borderRadius: 4,
            border: "1px solid #ccc",
            marginBottom: 16,
            fontFamily: "monospace",
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSave();
            if (e.key === "Escape") onCancel();
          }}
          autoFocus
        />

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button onClick={onCancel} disabled={saving} style={btnStyle("#e8edf2", "#333")}>
            Cancel
          </button>
          <button onClick={onDiscard} disabled={saving} style={btnStyle("#e74c3c", "#fff")}>
            Don't Save
          </button>
          <button onClick={handleSave} disabled={saving} style={btnStyle("#2980b9", "#fff")}>
            {saving ? "Saving…" : "Save & Close"}
          </button>
        </div>
      </div>
    </div>
  );
}

const overlayStyle: React.CSSProperties = {
  position: "fixed",
  inset: 0,
  backgroundColor: "rgba(0,0,0,0.5)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const dialogStyle: React.CSSProperties = {
  backgroundColor: "#fff",
  borderRadius: 8,
  padding: "24px 28px",
  width: 360,
  boxShadow: "0 8px 32px rgba(0,0,0,0.25)",
};

function btnStyle(bg: string, color: string): React.CSSProperties {
  return {
    padding: "7px 16px",
    fontSize: 13,
    borderRadius: 4,
    border: "none",
    backgroundColor: bg,
    color,
    cursor: "pointer",
    fontFamily: "sans-serif",
  };
}

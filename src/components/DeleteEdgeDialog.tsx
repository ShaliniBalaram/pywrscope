// src/components/DeleteEdgeDialog.tsx
// Confirmation dialog for deleting a single edge. Mirrors the visual shape
// of DeleteNodeDialog (red header, dialog actions) so the two destructive
// flows feel consistent. No orphan analysis needed — edges are leaf data.

import React from "react";

interface DeleteEdgeDialogProps {
  from: string;
  to: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function DeleteEdgeDialog({ from, to, onConfirm, onCancel }: DeleteEdgeDialogProps) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.4)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          padding: 24,
          minWidth: 360,
          maxWidth: 460,
          boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
          fontFamily: "sans-serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "#c0392b" }}>
          Delete edge
        </h3>
        <p style={{ fontSize: 13, color: "#444", margin: "0 0 8px 0" }}>
          Remove the connection
          {" "}
          <strong>"{from}" → "{to}"</strong>?
        </p>
        <p style={{ fontSize: 12, color: "#888", margin: "0 0 20px 0" }}>
          Use ⌘Z to undo.
        </p>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            onClick={onCancel}
            style={{
              padding: "6px 14px",
              border: "1px solid #ccc",
              borderRadius: 4,
              backgroundColor: "#fff",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            style={{
              padding: "6px 14px",
              border: "none",
              borderRadius: 4,
              backgroundColor: "#c0392b",
              color: "#fff",
              cursor: "pointer",
              fontSize: 12,
              fontWeight: "bold",
            }}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

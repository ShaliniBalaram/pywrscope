// src/components/DeleteNodeDialog.tsx
// Modal dialog for smart node deletion.
// Analyses orphaned nodes, presents reconnection options, then commits atomically.

import React, { useState, useMemo } from "react";
import { PywrModel } from "../types/pywr";

type ReconnectOption = "direct" | "to-existing" | "disconnect";

interface DeleteNodeDialogProps {
  nodeName: string;
  model: PywrModel;
  getOrphanedNodes: (name: string) => { upstream: string[]; downstream: string[] };
  removeNode: (name: string) => void;
  addEdge: (from: string, to: string) => void;
  onClose: () => void;
}

export function DeleteNodeDialog({
  nodeName,
  model,
  getOrphanedNodes,
  removeNode,
  addEdge,
  onClose,
}: DeleteNodeDialogProps) {
  const [reconnectOption, setReconnectOption] = useState<ReconnectOption>("disconnect");
  const [targetNode, setTargetNode] = useState<string>("");
  const [showPreview, setShowPreview] = useState(false);

  // Compute orphaned nodes and affected edges once
  const { upstream, downstream } = useMemo(
    () => getOrphanedNodes(nodeName),
    [getOrphanedNodes, nodeName]
  );

  const hasOrphans = upstream.length > 0 || downstream.length > 0;

  // All edges touching the node being deleted
  const edgesToRemove = useMemo(
    () =>
      model.edges.filter(
        (e) => e[0] === nodeName || e[1] === nodeName,
      ),
    [model.edges, nodeName]
  );

  // Direct upstream nodes (nodes that have an edge TO nodeName)
  const directUpstream = useMemo(
    () => model.edges.filter((e) => e[1] === nodeName).map((e) => e[0]),
    [model.edges, nodeName]
  );

  // Direct downstream nodes (nodes that nodeName feeds)
  const directDownstream = useMemo(
    () => model.edges.filter((e) => e[0] === nodeName).map((e) => e[1]),
    [model.edges, nodeName]
  );

  // Edges to add based on chosen reconnect option
  const edgesToAdd = useMemo((): Array<[string, string]> => {
    if (reconnectOption === "direct") {
      const edges: Array<[string, string]> = [];
      for (const up of directUpstream) {
        for (const down of directDownstream) {
          edges.push([up, down]);
        }
      }
      return edges;
    }
    if (reconnectOption === "to-existing" && targetNode) {
      return directUpstream.map((up) => [up, targetNode] as [string, string]);
    }
    return [];
  }, [reconnectOption, targetNode, directUpstream, directDownstream]);

  // Nodes that can be chosen as reconnect target — all except the one being deleted
  const candidateNodes = model.nodes
    .map((n) => n.name)
    .filter((n) => n !== nodeName);

  function handleConfirm() {
    // removeNode cascades: node + touching edges + dependent recorders +
    // node-array references all vanish in one atomic update (one undo step).
    // Then add any reconnect edges chosen by the user.
    removeNode(nodeName);
    for (const [from, to] of edgesToAdd) {
      addEdge(from, to);
    }
    onClose();
  }

  return (
    // Backdrop
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
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {/* Dialog box */}
      <div
        style={{
          backgroundColor: "#fff",
          borderRadius: 8,
          padding: 24,
          minWidth: 420,
          maxWidth: 540,
          boxShadow: "0 4px 24px rgba(0,0,0,0.18)",
          fontFamily: "sans-serif",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: 15, color: "#c0392b" }}>
          Delete node: {nodeName}
        </h3>

        {!hasOrphans ? (
          <p style={{ fontSize: 13, color: "#444", margin: "0 0 16px 0" }}>
            Delete <strong>{nodeName}</strong>? Touching edges and any recorders
            referencing this node will also be removed. Use ⌘Z to undo.
          </p>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#444", margin: "0 0 12px 0" }}>
              Deleting <strong>{nodeName}</strong> disconnects:
            </p>

            {upstream.length > 0 && (
              <div style={{ marginBottom: 6, fontSize: 12 }}>
                <strong>↑ Upstream:</strong>{" "}
                {upstream.join(", ")}
              </div>
            )}
            {downstream.length > 0 && (
              <div style={{ marginBottom: 12, fontSize: 12 }}>
                <strong>↓ Downstream:</strong>{" "}
                {downstream.join(", ")}
              </div>
            )}

            <p style={{ fontSize: 12, fontWeight: "bold", marginBottom: 8, color: "#333" }}>
              How should we handle the upstream nodes?
            </p>

            <label style={optionRowStyle}>
              <input
                type="radio"
                name="reconnect"
                value="direct"
                checked={reconnectOption === "direct"}
                onChange={() => { setReconnectOption("direct"); setShowPreview(false); }}
              />
              <span style={{ fontSize: 12, marginLeft: 6 }}>
                Connect each upstream node directly to each downstream node
              </span>
            </label>

            <label style={optionRowStyle}>
              <input
                type="radio"
                name="reconnect"
                value="to-existing"
                checked={reconnectOption === "to-existing"}
                onChange={() => { setReconnectOption("to-existing"); setShowPreview(false); }}
              />
              <span style={{ fontSize: 12, marginLeft: 6 }}>
                Connect upstream nodes to an existing node:
              </span>
              {reconnectOption === "to-existing" && (
                <select
                  value={targetNode}
                  onChange={(e) => { setTargetNode(e.target.value); setShowPreview(false); }}
                  style={{ marginLeft: 8, fontSize: 12, padding: "2px 4px" }}
                >
                  <option value="">— select node —</option>
                  {candidateNodes.map((n) => (
                    <option key={n} value={n}>{n}</option>
                  ))}
                </select>
              )}
            </label>

            <label style={optionRowStyle}>
              <input
                type="radio"
                name="reconnect"
                value="disconnect"
                checked={reconnectOption === "disconnect"}
                onChange={() => { setReconnectOption("disconnect"); setShowPreview(false); }}
              />
              <span style={{ fontSize: 12, marginLeft: 6 }}>
                Leave disconnected (flagged as warnings)
              </span>
            </label>
          </>
        )}

        {/* Preview */}
        {hasOrphans && (
          <button
            style={{ ...secondaryBtnStyle, marginTop: 8 }}
            onClick={() => setShowPreview((p) => !p)}
          >
            {showPreview ? "Hide Preview" : "Preview"}
          </button>
        )}

        {showPreview && (
          <div
            style={{
              backgroundColor: "#f5f5f5",
              borderRadius: 4,
              padding: "8px 10px",
              marginTop: 8,
              fontSize: 11,
              color: "#333",
            }}
          >
            {edgesToAdd.length > 0 && (
              <div>
                <strong>Will add edges:</strong>{" "}
                {edgesToAdd.map(([f, t]) => `${f} → ${t}`).join(", ")}
              </div>
            )}
            <div>
              <strong>Will remove edges:</strong>{" "}
              {edgesToRemove.map((e) => `${e[0]} → ${e[1]}`).join(", ")}
            </div>
          </div>
        )}

        {/* Action buttons */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 20 }}>
          <button style={secondaryBtnStyle} onClick={onClose}>
            Cancel
          </button>
          <button style={dangerBtnStyle} onClick={handleConfirm}>
            Confirm Delete
          </button>
        </div>
      </div>
    </div>
  );
}

const optionRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  marginBottom: 8,
  cursor: "pointer",
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "1px solid #ccc",
  borderRadius: 4,
  backgroundColor: "#fff",
  cursor: "pointer",
  fontSize: 12,
};

const dangerBtnStyle: React.CSSProperties = {
  padding: "6px 14px",
  border: "none",
  borderRadius: 4,
  backgroundColor: "#c0392b",
  color: "#fff",
  cursor: "pointer",
  fontSize: 12,
  fontWeight: "bold",
};

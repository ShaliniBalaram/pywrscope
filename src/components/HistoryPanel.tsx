// src/components/HistoryPanel.tsx
// Shows a chronological log of all changes made in the current session.

import React from "react";
import { HistoryEntry } from "../hooks/usePywrJson";

interface HistoryPanelProps {
  entries: HistoryEntry[];
}

function formatTime(d: Date): string {
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function HistoryPanel({ entries }: HistoryPanelProps) {
  if (entries.length === 0) {
    return (
      <div style={{ padding: 24, color: "#999", fontSize: 13, fontFamily: "sans-serif" }}>
        No changes yet. Open a file to start.
      </div>
    );
  }

  return (
    <div
      style={{
        flex: 1,
        overflowY: "auto",
        padding: "12px 16px",
        fontFamily: "sans-serif",
        fontSize: 13,
      }}
    >
      <div style={{ marginBottom: 10, color: "#555", fontSize: 12 }}>
        {entries.length} change{entries.length !== 1 ? "s" : ""} this session
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #ddd" }}>
            <th style={{ textAlign: "left", padding: "4px 8px", color: "#888", fontWeight: "normal", fontSize: 11, width: 80 }}>Time</th>
            <th style={{ textAlign: "left", padding: "4px 8px", color: "#888", fontWeight: "normal", fontSize: 11 }}>#</th>
            <th style={{ textAlign: "left", padding: "4px 8px", color: "#888", fontWeight: "normal", fontSize: 11 }}>Action</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry, i) => (
            <tr
              key={i}
              style={{
                borderBottom: "1px solid #f0f0f0",
                backgroundColor: i === 0 ? "#f0f7ff" : "transparent",
              }}
            >
              <td style={{ padding: "5px 8px", color: "#999", fontSize: 11, whiteSpace: "nowrap" }}>
                {formatTime(entry.timestamp)}
              </td>
              <td style={{ padding: "5px 8px", color: "#bbb", fontSize: 11, width: 36 }}>
                {entries.length - i}
              </td>
              <td style={{ padding: "5px 8px", color: i === 0 ? "#1a73e8" : "#333" }}>
                {entry.label}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

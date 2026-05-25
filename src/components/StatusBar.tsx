// src/components/StatusBar.tsx
// Thin bottom bar showing model statistics and current state.

import React from "react";
import { PywrModel } from "../types/pywr";

interface StatusBarProps {
  model: PywrModel | null;
  currentPath: string | null;
  isDirty: boolean;
  runDisabledReason: string | null;
  selectedCount: number;
}

export function StatusBar({ model, currentPath, isDirty, runDisabledReason, selectedCount }: StatusBarProps) {
  const fileName = currentPath
    ? currentPath.split(/[\\/]/).pop()
    : model
    ? "New Model"
    : null;

  return (
    <div style={{
      height: 24,
      backgroundColor: "#0f172a",
      borderTop: "1px solid #1e293b",
      display: "flex",
      alignItems: "center",
      padding: "0 12px",
      gap: 16,
      flexShrink: 0,
      userSelect: "none",
    }}>
      {/* File name */}
      <span style={{ color: isDirty ? "#fbbf24" : "#64748b", fontSize: 11, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 280 }}>
        {fileName
          ? <>{isDirty && <span style={{ marginRight: 4, color: "#fbbf24" }}>●</span>}{fileName}</>
          : <span style={{ color: "#374151" }}>No model open</span>
        }
      </span>

      {model && (
        <>
          <Sep />
          <Stat label="Nodes" value={model.nodes.length} />
          <Stat label="Edges" value={model.edges.length} />

          {/* Node type breakdown */}
          <Sep />
          <NodeTypeCounts model={model} />

          {selectedCount > 0 && (
            <>
              <Sep />
              <span style={{ color: "#60a5fa", fontSize: 11 }}>
                {selectedCount} selected
              </span>
            </>
          )}
        </>
      )}

      {/* Spacer */}
      <div style={{ flex: 1 }} />

      {model && (
        <span style={{ color: runDisabledReason ? "#fbbf24" : "#34d399", fontSize: 11 }}>
          {runDisabledReason ? `Run: ${runDisabledReason}` : "Run ready"}
        </span>
      )}

      {model && (
        <span style={{ color: "#374151", fontSize: 11 }}>
          PywrScope
        </span>
      )}
    </div>
  );
}

function Sep() {
  return <div style={{ width: 1, height: 13, backgroundColor: "#1e293b" }} />;
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <span style={{ color: "#475569", fontSize: 11 }}>
      <span style={{ color: "#94a3b8" }}>{value}</span>
      {" "}{label}
    </span>
  );
}

// Show counts per major node category (not every type — just the key groups)
function NodeTypeCounts({ model }: { model: PywrModel }) {
  const counts: Record<string, number> = {};
  for (const node of model.nodes) {
    counts[node.type] = (counts[node.type] ?? 0) + 1;
  }

  // Group into water-engineering categories
  const sources = (counts["Input"] ?? 0) + (counts["Catchment"] ?? 0) + (counts["Discharge"] ?? 0);
  const demands = counts["Output"] ?? 0;
  const storage = (counts["Storage"] ?? 0) + (counts["Reservoir"] ?? 0);
  const links   = Object.entries(counts)
    .filter(([t]) => ["Link","River","RiverGauge","RiverSplit","RiverSplitWithGauge","LossLink","BreakLink","PiecewiseLink","MultiSplitLink","DelayNode"].includes(t))
    .reduce((s, [, v]) => s + v, 0);

  const parts: Array<{ label: string; count: number; colour: string }> = [
    { label: "Sources",  count: sources,  colour: "#4ade80" },
    { label: "Demands",  count: demands,  colour: "#f87171" },
    { label: "Storage",  count: storage,  colour: "#60a5fa" },
    { label: "Links",    count: links,    colour: "#a78bfa" },
  ].filter(p => p.count > 0);

  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
      {parts.map(p => (
        <span key={p.label} style={{ fontSize: 11, color: "#475569" }}>
          <span style={{ color: p.colour }}>{p.count}</span>
          {" "}{p.label}
        </span>
      ))}
    </div>
  );
}

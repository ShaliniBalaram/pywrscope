// src/components/AddNodeModal.tsx
// Compact floating modal for picking a node type to add.
// Opened by the "Add Node" toolbar button; closes on Escape or outside click.

import React, { useState, useRef, useEffect } from "react";
import { NODE_COLOUR_MAP, NODE_DISPLAY_LABELS } from "../constants/nodeTypes";

const GROUPS: Array<{ label: string; types: string[] }> = [
  { label: "Sources",          types: ["Input", "Catchment", "Discharge"] },
  { label: "Flow Control",     types: ["Link", "LossLink", "BreakLink", "DelayNode"] },
  { label: "Multi-Output",     types: ["PiecewiseLink", "MultiSplitLink"] },
  { label: "Demand",           types: ["Output"] },
  { label: "Water Bodies",     types: ["Storage", "Reservoir", "River", "RiverGauge"] },
  { label: "River Routing",    types: ["RiverSplit", "RiverSplitWithGauge"] },
  { label: "Groundwater",      types: ["KeatingAquifer"] },
  { label: "Licence Tracking", types: ["VirtualStorage", "AnnualVirtualStorage", "SeasonalVirtualStorage", "MonthlyVirtualStorage", "RollingVirtualStorage"] },
  { label: "Aggregation",      types: ["AggregatedNode", "AggregatedStorage"] },
];

interface AddNodeModalProps {
  onAdd: (nodeType: string) => void;
  onClose: () => void;
}

export function AddNodeModal({ onAdd, onClose }: AddNodeModalProps) {
  const [search, setSearch] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = search.toLowerCase();
  const filtered = GROUPS.map((g) => ({
    ...g,
    types: g.types.filter(
      (t) => !q || t.toLowerCase().includes(q) || (NODE_DISPLAY_LABELS[t] ?? "").toLowerCase().includes(q)
    ),
  })).filter((g) => g.types.length > 0);

  return (
    <div
      ref={overlayRef}
      onClick={(e) => { if (e.target === overlayRef.current) onClose(); }}
      style={{
        position: "fixed", inset: 0,
        backgroundColor: "rgba(0,0,0,0.25)",
        display: "flex", alignItems: "flex-start", justifyContent: "center",
        paddingTop: 80, zIndex: 800,
      }}
    >
      <div style={{
        backgroundColor: "#fff", borderRadius: 8, width: 320,
        boxShadow: "0 8px 32px rgba(0,0,0,0.2)", overflow: "hidden",
      }}>
        {/* Search */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #eee" }}>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search node type…"
            style={{
              width: "100%", boxSizing: "border-box", padding: "6px 8px",
              border: "1px solid #ddd", borderRadius: 4, fontSize: 13,
            }}
          />
        </div>

        {/* Node list */}
        <div style={{ maxHeight: 400, overflowY: "auto", padding: "6px 0" }}>
          {filtered.map((group) => (
            <div key={group.label}>
              <div style={{
                fontSize: 10, fontWeight: "bold", color: "#999",
                padding: "4px 12px 2px", textTransform: "uppercase", letterSpacing: "0.05em",
              }}>
                {group.label}
              </div>
              {group.types.map((nodeType) => (
                <button
                  key={nodeType}
                  onClick={() => { onAdd(nodeType); onClose(); }}
                  style={{
                    display: "flex", alignItems: "center", gap: 10,
                    width: "100%", padding: "7px 12px",
                    border: "none", background: "none", cursor: "pointer",
                    textAlign: "left", fontSize: 13,
                  }}
                  onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = "#f0f6ff")}
                  onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                >
                  <span style={{
                    width: 12, height: 12, borderRadius: 3, flexShrink: 0,
                    backgroundColor: NODE_COLOUR_MAP[nodeType] ?? "#888",
                  }} />
                  <span style={{ color: "#333" }}>{NODE_DISPLAY_LABELS[nodeType] ?? nodeType}</span>
                  <span style={{ color: "#bbb", fontSize: 11, marginLeft: "auto" }}>{nodeType}</span>
                </button>
              ))}
            </div>
          ))}
          {filtered.length === 0 && (
            <div style={{ padding: "16px 12px", color: "#999", fontSize: 13 }}>No match</div>
          )}
        </div>
      </div>
    </div>
  );
}

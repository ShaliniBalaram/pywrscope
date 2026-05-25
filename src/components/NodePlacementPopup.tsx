import React, { useState, useEffect, useRef } from "react";
import { NODE_COLOUR_MAP, NODE_DISPLAY_LABELS } from "../constants/nodeTypes";

const GROUPS = [
  { label: "Sources", types: ["Input", "Catchment", "Discharge"] },
  { label: "Flow Control", types: ["Link", "LossLink", "BreakLink", "DelayNode"] },
  { label: "Multi-Output", types: ["PiecewiseLink", "MultiSplitLink"] },
  { label: "Demand", types: ["Output"] },
  { label: "Water Bodies", types: ["Storage", "Reservoir", "River", "RiverGauge"] },
  { label: "River Routing", types: ["RiverSplit", "RiverSplitWithGauge"] },
  { label: "Groundwater", types: ["KeatingAquifer"] },
  { label: "Licence Tracking", types: ["VirtualStorage", "AnnualVirtualStorage", "SeasonalVirtualStorage", "MonthlyVirtualStorage", "RollingVirtualStorage"] },
  { label: "Aggregation", types: ["AggregatedNode", "AggregatedStorage"] },
];

interface Props {
  screenX: number;
  screenY: number;
  defaultName: string;
  onConfirm: (name: string, nodeType: string) => void;
  onCancel: () => void;
}

export function NodePlacementPopup({ screenX, screenY, defaultName, onConfirm, onCancel }: Props) {
  const [name, setName] = useState(defaultName);
  const [nodeType, setNodeType] = useState("Link");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => { nameRef.current?.focus(); }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === "Escape") onCancel(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Keep popup on screen
  const POP_W = 240, POP_H = 200;
  const left = Math.min(screenX, window.innerWidth - POP_W - 12);
  const top = Math.min(screenY + 12, window.innerHeight - POP_H - 12);

  const colour = NODE_COLOUR_MAP[nodeType] ?? "#888";

  return (
    <div style={{
      position: "fixed", left, top, width: POP_W, zIndex: 900,
      backgroundColor: "#fff", borderRadius: 8, boxShadow: "0 6px 24px rgba(0,0,0,0.2)",
      padding: "14px 14px 12px", fontFamily: "sans-serif",
      border: `2px solid ${colour}`,
    }}>
      <div style={{ fontSize: 11, fontWeight: "bold", color: colour, marginBottom: 10, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        Place Node
      </div>

      <label style={{ fontSize: 11, color: "#666", display: "block", marginBottom: 2 }}>Name</label>
      <input
        ref={nameRef}
        value={name}
        onChange={e => setName(e.target.value)}
        style={{ width: "100%", boxSizing: "border-box", padding: "5px 7px", borderRadius: 4, border: "1px solid #ddd", fontSize: 12, marginBottom: 8 }}
        onKeyDown={e => { if (e.key === "Enter") onConfirm(name.trim() || defaultName, nodeType); }}
      />

      <label style={{ fontSize: 11, color: "#666", display: "block", marginBottom: 2 }}>Type</label>
      <select
        value={nodeType}
        onChange={e => setNodeType(e.target.value)}
        style={{ width: "100%", padding: "5px 7px", borderRadius: 4, border: "1px solid #ddd", fontSize: 12, marginBottom: 12, backgroundColor: "#fff" }}
      >
        {GROUPS.map(g => (
          <optgroup key={g.label} label={g.label}>
            {g.types.map(t => (
              <option key={t} value={t}>{NODE_DISPLAY_LABELS[t] ?? t}</option>
            ))}
          </optgroup>
        ))}
      </select>

      <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
        <button onClick={onCancel} style={{ padding: "5px 12px", fontSize: 12, borderRadius: 4, border: "1px solid #ddd", background: "#f5f5f5", cursor: "pointer" }}>Cancel</button>
        <button
          onClick={() => onConfirm(name.trim() || defaultName, nodeType)}
          style={{ padding: "5px 12px", fontSize: 12, borderRadius: 4, border: "none", background: colour, color: "#fff", cursor: "pointer", fontWeight: "bold" }}
        >
          Place
        </button>
      </div>
    </div>
  );
}

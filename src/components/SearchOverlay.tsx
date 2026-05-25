// src/components/SearchOverlay.tsx
// Cmd+F search overlay — filters nodes by name and zooms to the selected one.

import React, { useState, useRef, useEffect } from "react";
import { PywrModel } from "../types/pywr";

interface SearchOverlayProps {
  model: PywrModel;
  onSelect: (nodeName: string) => void;
  onClose: () => void;
}

export function SearchOverlay({ model, onSelect, onClose }: SearchOverlayProps) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const matches = query.trim()
    ? model.nodes.filter(n => n.name.toLowerCase().includes(query.toLowerCase()))
    : model.nodes;

  const safeIndex = Math.min(activeIndex, matches.length - 1);

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Escape") { onClose(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex(i => Math.min(i + 1, matches.length - 1)); }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActiveIndex(i => Math.max(i - 1, 0)); }
    if (e.key === "Enter" && matches[safeIndex]) { onSelect(matches[safeIndex].name); onClose(); }
  }

  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 900, display: "flex", alignItems: "flex-start", justifyContent: "center", paddingTop: 80 }}
      onClick={onClose}
    >
      <div
        style={{ backgroundColor: "#fff", borderRadius: 10, boxShadow: "0 8px 32px rgba(0,0,0,0.22)", width: 380, overflow: "hidden", fontFamily: "sans-serif" }}
        onClick={e => e.stopPropagation()}
      >
        {/* Input */}
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", borderBottom: "1px solid #e5e7eb", gap: 8 }}>
          <span style={{ color: "#9ca3af", fontSize: 15 }}>🔍</span>
          <input
            ref={inputRef}
            value={query}
            onChange={e => { setQuery(e.target.value); setActiveIndex(0); }}
            onKeyDown={handleKey}
            placeholder="Search nodes…"
            style={{ flex: 1, border: "none", outline: "none", fontSize: 14, color: "#111827", background: "transparent" }}
          />
          <span style={{ fontSize: 11, color: "#9ca3af" }}>{matches.length} node{matches.length !== 1 ? "s" : ""}</span>
        </div>

        {/* Results */}
        <div style={{ maxHeight: 300, overflowY: "auto" }}>
          {matches.length === 0 ? (
            <div style={{ padding: "16px 14px", fontSize: 13, color: "#9ca3af", textAlign: "center" }}>No nodes found</div>
          ) : (
            matches.map((node, i) => (
              <div
                key={node.name}
                onClick={() => { onSelect(node.name); onClose(); }}
                style={{
                  padding: "8px 14px",
                  fontSize: 13,
                  cursor: "pointer",
                  backgroundColor: i === safeIndex ? "#eff6ff" : "transparent",
                  color: i === safeIndex ? "#1d4ed8" : "#374151",
                  borderLeft: i === safeIndex ? "3px solid #3b82f6" : "3px solid transparent",
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                }}
                onMouseEnter={() => setActiveIndex(i)}
              >
                <span>{node.name}</span>
                <span style={{ fontSize: 11, color: "#9ca3af" }}>{node.type}</span>
              </div>
            ))
          )}
        </div>

        <div style={{ padding: "6px 14px", borderTop: "1px solid #e5e7eb", fontSize: 11, color: "#9ca3af", display: "flex", gap: 12 }}>
          <span>↑↓ navigate</span><span>↵ zoom to node</span><span>Esc close</span>
        </div>
      </div>
    </div>
  );
}

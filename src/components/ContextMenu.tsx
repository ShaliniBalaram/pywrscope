// src/components/ContextMenu.tsx
// Generic floating context menu, used by right-click on nodes and edges.
// Restores the standard right-click-opens-menu convention (replacing the
// previous behaviour where right-click silently triggered delete).
//
// Dismisses on outside click, Escape, or after an item is chosen.

import React, { useEffect, useRef } from "react";

export interface ContextMenuItem {
  label: string;
  onClick: () => void;
  danger?: boolean;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);

  // Outside-click + Escape close the menu.
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  // Clamp position to viewport so menu never overflows off-screen.
  // Estimate ~150px wide / 32px per item; conservative defaults.
  const estWidth = 170;
  const estHeight = items.length * 32 + 8;
  const left = Math.min(x, window.innerWidth - estWidth - 4);
  const top = Math.min(y, window.innerHeight - estHeight - 4);

  return (
    <div
      ref={ref}
      style={{
        position: "fixed",
        left,
        top,
        zIndex: 1100,
        backgroundColor: "#1f2937",
        border: "1px solid #374151",
        borderRadius: 6,
        boxShadow: "0 4px 16px rgba(0,0,0,0.4)",
        minWidth: 150,
        padding: "4px 0",
        fontFamily: "sans-serif",
        userSelect: "none",
      }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          onClick={() => {
            item.onClick();
            onClose();
          }}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            backgroundColor: "transparent",
            border: "none",
            padding: "6px 14px",
            fontSize: 12,
            color: item.danger ? "#fca5a5" : "#e5e7eb",
            cursor: "pointer",
            fontFamily: "inherit",
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = item.danger
              ? "#7f1d1d"
              : "#374151";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLButtonElement).style.backgroundColor = "transparent";
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

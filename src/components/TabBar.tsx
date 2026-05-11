import React from "react";

export type AppTab = "canvas" | "json" | "map" | "results" | "history";

interface TabBarProps {
  activeTab: AppTab;
  hasModel: boolean;
  onTabChange: (tab: AppTab) => void;
}

export function TabBar({ activeTab, hasModel, onTabChange }: TabBarProps) {
  return (
    <div style={{
      display: "flex", alignItems: "flex-end",
      backgroundColor: "#0f172a",
      paddingLeft: 14, gap: 2, flexShrink: 0,
      borderBottom: "1px solid #1e293b",
    }}>
      {[
        { tab: "canvas" as AppTab, label: "Canvas", disabled: false },
        { tab: "json" as AppTab, label: "JSON", disabled: !hasModel, title: hasModel ? "Edit raw model JSON" : "Open a model first" },
        { tab: "map" as AppTab, label: "Map", disabled: !hasModel, title: hasModel ? "Map view — trace positions, run on Pywr" : "Open a model first" },
        { tab: "results" as AppTab, label: "Results", disabled: !hasModel, title: hasModel ? "Trace downstream flows — click a node to see its active outputs" : "Open a model first" },
        { tab: "history" as AppTab, label: "History", disabled: !hasModel, title: "Change log" },
      ].map(({ tab, label, disabled, title }) => (
        <button
          key={tab}
          onClick={() => !disabled && onTabChange(tab)}
          title={title}
          style={{
            padding: "7px 16px", fontSize: 12,
            fontWeight: activeTab === tab ? 600 : 400,
            color: activeTab === tab ? "#0f172a" : disabled ? "#334155" : "#64748b",
            backgroundColor: activeTab === tab ? "#f8fafc" : "transparent",
            border: "none",
            borderTop: activeTab === tab ? "2px solid #3B8BD4" : "2px solid transparent",
            borderRadius: "6px 6px 0 0",
            cursor: disabled ? "not-allowed" : "pointer",
            userSelect: "none",
            fontFamily: "sans-serif",
            transition: "color 0.12s, background-color 0.12s",
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

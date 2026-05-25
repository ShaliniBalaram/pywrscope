// src/components/RunPanel.tsx
// Bottom-docked panel that shows live progress for an active or just-finished
// Pywr model run. Rendered conditionally by App.tsx when status !== "idle".
//
// The panel is dumb: it owns no run state. All transitions are driven by the
// useModelRun hook so a hot-reload or remount can never lose state.

import React from "react";
import type { RunStateView } from "../hooks/useModelRun";

interface RunPanelProps {
  state: RunStateView;
  onCancel: () => void;
  onClose: () => void;
}

export function RunPanel({ state, onCancel, onClose }: RunPanelProps) {
  const isActive = state.status === "starting" || state.status === "running";
  const isTerminal = state.status === "done" || state.status === "error" || state.status === "cancelled";

  return (
    <div
      role="dialog"
      aria-label="Pywr model run"
      style={{
        position: "absolute",
        right: 16,
        bottom: 16,
        width: 420,
        maxHeight: "60vh",
        backgroundColor: "#111827",
        border: "1px solid #1f2937",
        borderRadius: 10,
        boxShadow: "0 10px 30px rgba(0,0,0,0.45)",
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        color: "#e5e7eb",
        fontFamily: "sans-serif",
        zIndex: 200,
      }}
    >
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "10px 14px", borderBottom: "1px solid #1f2937",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <StatusDot status={state.status} />
          <span style={{ fontSize: 13, fontWeight: 600 }}>
            {headerTitle(state.status)}
          </span>
        </div>
        <button
          onClick={onClose}
          disabled={isActive}
          aria-label="Close run panel"
          title={isActive ? "Cancel the run before closing" : "Close"}
          style={{
            background: "transparent",
            border: "none",
            color: isActive ? "#4b5563" : "#9ca3af",
            cursor: isActive ? "not-allowed" : "pointer",
            fontSize: 16,
            padding: 0,
            width: 24,
            height: 24,
          }}
        >
          ✕
        </button>
      </div>

      {/* Progress */}
      {(isActive || state.status === "done") && (
        <div style={{ padding: "10px 14px" }}>
          <div style={{
            display: "flex", justifyContent: "space-between",
            fontSize: 11, color: "#9ca3af", marginBottom: 5,
          }}>
            <span>{state.step.toLocaleString()} / {state.total.toLocaleString()} steps</span>
            <span>{state.date || "—"}</span>
          </div>
          <div style={{
            position: "relative",
            height: 8,
            backgroundColor: "#1f2937",
            borderRadius: 4,
            overflow: "hidden",
          }}>
            <div style={{
              position: "absolute",
              inset: 0,
              right: `${100 - state.pct}%`,
              backgroundColor: state.status === "done" ? "#10b981" : "#3B8BD4",
              transition: "right 0.2s ease",
            }} />
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af", marginTop: 4 }}>
            {state.pct}%{state.stats ? ` · ${state.stats.seconds.toFixed(2)}s` : ""}
          </div>
        </div>
      )}

      {/* Error */}
      {state.status === "error" && state.error && (
        <ErrorBlock error={state.error} />
      )}

      {/* Cancelled note */}
      {state.status === "cancelled" && (
        <div style={{ padding: "10px 14px", fontSize: 12, color: "#fbbf24" }}>
          Run cancelled. Partial outputs may exist in {state.outDir ?? "the output folder"}.
        </div>
      )}

      {/* Outputs (on done) */}
      {state.status === "done" && state.outputs.length > 0 && (
        <OutputsList outputs={state.outputs} outDir={state.outDir} />
      )}

      {/* Footer actions */}
      <div style={{
        marginTop: "auto",
        padding: "10px 14px",
        borderTop: "1px solid #1f2937",
        display: "flex",
        gap: 8,
        justifyContent: "flex-end",
      }}>
        {isActive && (
          <button
            onClick={onCancel}
            style={btnStyle("#dc2626", "#ef4444")}
            title="Stop the running model"
          >
            Cancel
          </button>
        )}
        {isTerminal && (
          <button
            onClick={onClose}
            style={btnStyle("#1f2937", "#374151")}
          >
            Dismiss
          </button>
        )}
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: RunStateView["status"] }) {
  const color =
    status === "running" || status === "starting" ? "#3B8BD4" :
    status === "done" ? "#10b981" :
    status === "error" ? "#ef4444" :
    status === "cancelled" ? "#fbbf24" :
    "#6b7280";
  const pulse = status === "running" || status === "starting";
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: color,
        animation: pulse ? "pywr-pulse 1.4s ease-in-out infinite" : undefined,
      }}
    />
  );
}

function headerTitle(status: RunStateView["status"]): string {
  switch (status) {
    case "starting": return "Starting Pywr…";
    case "running":  return "Running";
    case "done":     return "Run complete";
    case "error":    return "Run failed";
    case "cancelled": return "Run cancelled";
    case "idle":     return "Idle";
  }
}

function ErrorBlock({ error }: { error: NonNullable<RunStateView["error"]> }) {
  const [open, setOpen] = React.useState(false);
  return (
    <div style={{ padding: "10px 14px" }}>
      <div style={{
        fontSize: 12,
        color: "#fca5a5",
        marginBottom: 6,
        fontWeight: 600,
      }}>
        {error.code}
      </div>
      <div style={{ fontSize: 12, color: "#e5e7eb", marginBottom: 6, wordBreak: "break-word" }}>
        {error.message}
      </div>
      {error.traceback && (
        <>
          <button
            onClick={() => setOpen((o) => !o)}
            style={{
              background: "none",
              border: "none",
              color: "#9ca3af",
              fontSize: 11,
              cursor: "pointer",
              padding: 0,
            }}
          >
            {open ? "▾ hide traceback" : "▸ show traceback"}
          </button>
          {open && (
            <pre style={{
              marginTop: 6,
              padding: 8,
              fontSize: 10,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              color: "#d1d5db",
              backgroundColor: "#0b1220",
              border: "1px solid #1f2937",
              borderRadius: 6,
              overflow: "auto",
              maxHeight: 200,
              whiteSpace: "pre-wrap",
            }}>
              {error.traceback}
            </pre>
          )}
        </>
      )}
    </div>
  );
}

function OutputsList({
  outputs,
  outDir,
}: {
  outputs: RunStateView["outputs"];
  outDir: string | null;
}) {
  return (
    <div style={{ padding: "10px 14px", borderTop: "1px solid #1f2937" }}>
      <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 6 }}>
        Outputs ({outputs.length}):
      </div>
      <ul style={{ margin: 0, padding: 0, listStyle: "none", maxHeight: 120, overflow: "auto" }}>
        {outputs.map((o) => (
          <li key={o.path} style={{
            fontSize: 11,
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            color: "#d1d5db",
            padding: "2px 0",
            wordBreak: "break-all",
          }}>
            <span style={{ color: "#6b7280" }}>{o.name} → </span>{o.path}
          </li>
        ))}
      </ul>
      {outDir && (
        <div style={{ fontSize: 10, color: "#6b7280", marginTop: 6 }}>
          {outDir}
        </div>
      )}
    </div>
  );
}

function btnStyle(bg: string, hoverBg: string): React.CSSProperties {
  return {
    backgroundColor: bg,
    color: "#fff",
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    cursor: "pointer",
    transition: "background-color 0.12s",
    // hoverBg consumed via inline mouseover handlers in callers if needed.
    // Kept here so the colour vocabulary lives next to the button declaration.
    outline: hoverBg ? undefined : undefined,
  };
}

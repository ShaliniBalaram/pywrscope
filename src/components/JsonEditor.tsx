// src/components/JsonEditor.tsx
// Lightweight JSON editor — plain textarea, no Monaco, no web-workers.
// Instant to open, works in all Tauri WebViews without CSP changes.

import React, { useState, useEffect, useRef } from "react";
import { PywrModel } from "../types/pywr";

interface JsonEditorProps {
  model: PywrModel;
  onApply: (model: PywrModel) => void;
}

export function JsonEditor({ model, onApply }: JsonEditorProps) {
  const [jsonText, setJsonText] = useState(() => JSON.stringify(model, null, 2));
  const [parseError, setParseError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const modelRef = useRef(model);
  const taRef = useRef<HTMLTextAreaElement>(null);

  // Keep in sync when canvas edits happen, unless user has unsaved edits here
  useEffect(() => {
    if (!isDirty) {
      setJsonText(JSON.stringify(model, null, 2));
    }
    modelRef.current = model;
  }, [model, isDirty]);

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const text = e.target.value;
    setJsonText(text);
    setIsDirty(true);
    try {
      JSON.parse(text);
      setParseError(null);
    } catch (err) {
      setParseError((err as Error).message);
    }
  }

  // Tab key inserts 2 spaces instead of jumping focus
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Tab") {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = jsonText.slice(0, start) + "  " + jsonText.slice(end);
      setJsonText(next);
      setIsDirty(true);
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }

  function handleApply() {
    try {
      const parsed = JSON.parse(jsonText) as PywrModel;
      setParseError(null);
      setIsDirty(false);
      onApply(parsed);
    } catch (e) {
      setParseError((e as Error).message);
    }
  }

  function handleDiscard() {
    setJsonText(JSON.stringify(modelRef.current, null, 2));
    setParseError(null);
    setIsDirty(false);
  }

  // Format (pretty-print) the current text
  function handleFormat() {
    try {
      const parsed = JSON.parse(jsonText);
      const pretty = JSON.stringify(parsed, null, 2);
      setJsonText(pretty);
      setParseError(null);
    } catch (e) {
      setParseError((e as Error).message);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, overflow: "hidden" }}>
      {/* Toolbar */}
      <div style={{
        display: "flex", alignItems: "center",
        padding: "6px 12px",
        backgroundColor: "#1e293b",
        borderBottom: "1px solid #334155",
        gap: 8, flexShrink: 0,
      }}>
        <span style={{ fontSize: 11, color: "#94a3b8", fontFamily: "sans-serif", flex: 1 }}>
          Edit parameters, recorders, timestepper, metadata directly.
          {isDirty && (
            <span style={{ color: "#f59e0b", marginLeft: 8, fontWeight: "bold" }}>
              Unsaved changes
            </span>
          )}
        </span>

        <button onClick={handleFormat} style={btn("secondary")} title="Pretty-print the JSON">
          Format
        </button>

        {isDirty && (
          <button onClick={handleDiscard} style={btn("secondary")} title="Revert to canvas model">
            Discard
          </button>
        )}

        <button
          onClick={handleApply}
          disabled={!!parseError}
          style={btn(parseError ? "disabled" : "primary")}
          title="Push JSON changes to the canvas"
        >
          Apply Changes
        </button>
      </div>

      {/* Inline parse error */}
      {parseError && (
        <div style={{
          padding: "4px 12px",
          backgroundColor: "#450a0a",
          borderBottom: "1px solid #7f1d1d",
          color: "#fca5a5",
          fontSize: 11,
          fontFamily: "monospace",
          flexShrink: 0,
        }}>
          ✕ {parseError}
        </div>
      )}

      {/* Editor textarea */}
      <textarea
        ref={taRef}
        value={jsonText}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          outline: "none",
          padding: "14px 18px",
          fontFamily: '"Fira Code", "Cascadia Code", Consolas, Menlo, "Courier New", monospace',
          fontSize: 12.5,
          lineHeight: 1.65,
          backgroundColor: "#0f172a",
          color: "#e2e8f0",
          tabSize: 2,
          whiteSpace: "pre",
          overflowWrap: "normal",
          overflowX: "auto",
        }}
      />
    </div>
  );
}

type BtnVariant = "primary" | "secondary" | "disabled";

function btn(variant: BtnVariant): React.CSSProperties {
  const base: React.CSSProperties = {
    padding: "4px 12px", fontSize: 11,
    fontFamily: "sans-serif", fontWeight: "bold",
    border: "none", borderRadius: 4,
    cursor: variant === "disabled" ? "not-allowed" : "pointer",
  };
  if (variant === "primary")   return { ...base, backgroundColor: "#3b82f6", color: "#fff" };
  if (variant === "secondary") return { ...base, backgroundColor: "#334155", color: "#cbd5e1" };
  return { ...base, backgroundColor: "#1e293b", color: "#475569" };
}

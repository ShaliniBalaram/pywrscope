// src/components/ValidationBar.tsx
// Bottom status bar. Calls POST /api/validate on every model change (debounced 1000ms).
// Errors shown in red, warnings in amber.
// Clicking a warning/error highlights the relevant node for 2s.

import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { PywrModel } from "../types/pywr";

interface ValidationIssue {
  code: string;
  severity: "error" | "warning";
  message: string;
  node_name: string;
}

interface ValidationBarProps {
  model: PywrModel | null;
  onNodeHighlight: (nodeName: string) => void;
}

// Error codes — shown in red
const ERROR_CODES = new Set([
  "DUPLICATE_NODE_NAME",
  "ORPHANED_EDGE",
  "MISSING_REQUIRED_FIELD",
  "INVALID_NODE_TYPE",
  "MODEL_STRUCTURE_ERROR",
]);

export function ValidationBar({ model, onNodeHighlight }: ValidationBarProps) {
  const [errors, setErrors] = useState<ValidationIssue[]>([]);
  const [warnings, setWarnings] = useState<ValidationIssue[]>([]);
  const [isValidating, setIsValidating] = useState(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runValidation = useCallback(async (m: PywrModel) => {
    setIsValidating(true);
    try {
      const response = await window.pywr.callApi("/api/validate", { model: m });
      const resp = response as { ok: boolean; data?: { errors: ValidationIssue[]; warnings: ValidationIssue[] }; error?: string };
      if (resp.ok && resp.data) {
        setErrors(resp.data.errors);
        setWarnings(resp.data.warnings);
      } else {
        setErrors([]);
        setWarnings([]);
      }
    } catch {
      // Backend not available — clear results silently
      setErrors([]);
      setWarnings([]);
    } finally {
      setIsValidating(false);
    }
  }, []);

  // Lightweight fingerprint — only node names/types and edge topology matter
  // for validation. Avoids serialising the entire model (parameters, recorders,
  // etc.) on every change, which is expensive for large models.
  const modelFingerprint = useMemo(() => {
    if (!model) return null;
    const nodeKey = model.nodes.map(n => `${n.name}:${n.type}`).join(",");
    const edgeKey = model.edges.map(e => `${e[0]}->${e[1]}`).join(",");
    return `${model.nodes.length}|${model.edges.length}|${nodeKey}|${edgeKey}`;
  }, [model]);

  useEffect(() => {
    if (!model || modelFingerprint === null) {
      setErrors([]);
      setWarnings([]);
      return;
    }

    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      runValidation(model);
    }, 1000);

    return () => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
    };
  }, [modelFingerprint, runValidation]); // eslint-disable-line react-hooks/exhaustive-deps

  const errorCount = errors.length;
  const warningCount = warnings.length;

  function handleIssueClick(issue: ValidationIssue) {
    if (issue.node_name) onNodeHighlight(issue.node_name);
  }

  return (
    <div
      style={{
        height: 36,
        backgroundColor: "#1e1e1e",
        borderTop: "1px solid #333",
        display: "flex",
        alignItems: "center",
        padding: "0 12px",
        gap: 16,
        flexShrink: 0,
        overflowX: "auto",
        fontFamily: "monospace",
        fontSize: 11,
      }}
    >
      {isValidating && (
        <span style={{ color: "#888" }}>Validating…</span>
      )}

      {!isValidating && !model && (
        <span style={{ color: "#666" }}>No model loaded</span>
      )}

      {!isValidating && model && errorCount === 0 && warningCount === 0 && (
        <span style={{ color: "#27ae60" }}>✓ No issues</span>
      )}

      {/* Error pills */}
      {errors.map((issue, i) => (
        <button
          key={`err-${i}`}
          onClick={() => handleIssueClick(issue)}
          title={issue.message}
          style={pillStyle("#c0392b")}
        >
          ✕ {issue.code}
          {issue.node_name ? `: ${issue.node_name}` : ""}
        </button>
      ))}

      {/* Warning pills */}
      {warnings.map((issue, i) => (
        <button
          key={`warn-${i}`}
          onClick={() => handleIssueClick(issue)}
          title={issue.message}
          style={pillStyle("#e67e22")}
        >
          ⚠ {issue.code}
          {issue.node_name ? `: ${issue.node_name}` : ""}
        </button>
      ))}

      {/* Summary counts at right */}
      <div style={{ marginLeft: "auto", display: "flex", gap: 10 }}>
        {errorCount > 0 && (
          <span style={{ color: "#e74c3c", fontWeight: "bold" }}>
            {errorCount} error{errorCount !== 1 ? "s" : ""}
          </span>
        )}
        {warningCount > 0 && (
          <span style={{ color: "#f39c12", fontWeight: "bold" }}>
            {warningCount} warning{warningCount !== 1 ? "s" : ""}
          </span>
        )}
      </div>
    </div>
  );
}

function pillStyle(colour: string): React.CSSProperties {
  return {
    backgroundColor: colour,
    color: "#fff",
    border: "none",
    borderRadius: 3,
    padding: "2px 7px",
    fontSize: 10,
    cursor: "pointer",
    fontFamily: "monospace",
    whiteSpace: "nowrap",
    flexShrink: 0,
  };
}

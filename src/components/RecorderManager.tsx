import React from "react";
import type { PywrModel, PywrNode, PywrRecorder } from "../types/pywr";
import { normalizeNodeType } from "../constants/nodeTypes";

type RecorderKind = "flow" | "deficit" | "storage" | "normalisedStorage";
type Scope = "selected" | "all";

interface RecorderManagerProps {
  model: PywrModel;
  selectedNodeNames: string[];
  onApply: (model: PywrModel, addedCount: number) => void;
}

const RECORDER_OPTIONS: Array<{ kind: RecorderKind; label: string; type: string }> = [
  { kind: "flow", label: "Flow", type: "NumpyArrayNodeRecorder" },
  { kind: "deficit", label: "Deficit", type: "NumpyArrayNodeDeficitRecorder" },
  { kind: "storage", label: "Storage", type: "NumpyArrayStorageRecorder" },
  { kind: "normalisedStorage", label: "Normalised", type: "NumpyArrayNormalisedStorageRecorder" },
];

const STORAGE_NODE_TYPES = new Set([
  "Storage",
  "Reservoir",
  "VirtualStorage",
  "AnnualVirtualStorage",
  "SeasonalVirtualStorage",
  "MonthlyVirtualStorage",
  "RollingVirtualStorage",
  "AggregatedStorage",
]);

export function RecorderManager({ model, selectedNodeNames, onApply }: RecorderManagerProps) {
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState<Scope>(selectedNodeNames.length > 0 ? "selected" : "all");
  const [kinds, setKinds] = React.useState<Record<RecorderKind, boolean>>({
    flow: true,
    deficit: false,
    storage: true,
    normalisedStorage: false,
  });
  const [lastMessage, setLastMessage] = React.useState<string>("");

  React.useEffect(() => {
    if (selectedNodeNames.length > 0) setScope("selected");
  }, [selectedNodeNames.length]);

  const targetNodes = React.useMemo(() => {
    const selected = new Set(selectedNodeNames);
    return model.nodes.filter((n) => scope === "all" || selected.has(n.name));
  }, [model.nodes, scope, selectedNodeNames]);

  const selectedKinds = RECORDER_OPTIONS.filter((o) => kinds[o.kind]);
  const existingCount = Object.keys(model.recorders ?? {}).length;

  function toggleKind(kind: RecorderKind) {
    setKinds((prev) => ({ ...prev, [kind]: !prev[kind] }));
  }

  function apply() {
    const result = addRecordersForNodes(model, targetNodes, selectedKinds.map((k) => k.kind));
    if (result.addedCount > 0) {
      onApply(result.model, result.addedCount);
      setLastMessage(`Added ${result.addedCount} recorder${result.addedCount === 1 ? "" : "s"}.`);
    } else {
      setLastMessage("No new recorders to add.");
    }
  }

  return (
    <div
      style={{
        position: "absolute",
        left: 12,
        bottom: 12,
        zIndex: 25,
        width: open ? 300 : 148,
        fontFamily: "sans-serif",
      }}
    >
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          style={buttonStyle("#0f172a", 148)}
          title="Add recorders for selected nodes or the full model"
        >
          Recorders
        </button>
      ) : (
        <div
          style={{
            background: "rgba(255,255,255,0.96)",
            border: "1px solid #cbd5e1",
            borderRadius: 6,
            boxShadow: "0 10px 24px rgba(15,23,42,0.22)",
            padding: 10,
            color: "#0f172a",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 800 }}>Recorder Manager</div>
              <div style={{ fontSize: 10, color: "#64748b" }}>
                {existingCount.toLocaleString()} existing
              </div>
            </div>
            <button
              onClick={() => setOpen(false)}
              style={{ border: "none", background: "transparent", cursor: "pointer", fontSize: 16, color: "#64748b" }}
              aria-label="Close recorder manager"
            >
              x
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            <button
              onClick={() => setScope("selected")}
              disabled={selectedNodeNames.length === 0}
              style={segStyle(scope === "selected", selectedNodeNames.length === 0)}
              title={selectedNodeNames.length === 0 ? "Select nodes first" : "Add recorders to selected nodes"}
            >
              Selected ({selectedNodeNames.length})
            </button>
            <button
              onClick={() => setScope("all")}
              style={segStyle(scope === "all", false)}
              title="Add recorders across the full model"
            >
              All ({model.nodes.length})
            </button>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6, marginBottom: 8 }}>
            {RECORDER_OPTIONS.map((opt) => (
              <label
                key={opt.kind}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  fontSize: 11,
                  padding: "6px 7px",
                  border: "1px solid #cbd5e1",
                  borderRadius: 4,
                  background: kinds[opt.kind] ? "#f1f5f9" : "#fff",
                  cursor: "pointer",
                }}
              >
                <input
                  type="checkbox"
                  checked={kinds[opt.kind]}
                  onChange={() => toggleKind(opt.kind)}
                />
                {opt.label}
              </label>
            ))}
          </div>

          <div style={{ fontSize: 10, color: "#64748b", marginBottom: 8 }}>
            Target nodes: {targetNodes.length.toLocaleString()}
          </div>

          <button
            onClick={apply}
            disabled={targetNodes.length === 0 || selectedKinds.length === 0}
            style={buttonStyle("#2563eb", "100%", targetNodes.length === 0 || selectedKinds.length === 0)}
          >
            Add recorders
          </button>

          {lastMessage && (
            <div style={{ fontSize: 11, color: "#334155", marginTop: 8 }}>
              {lastMessage}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function addRecordersForNodes(
  model: PywrModel,
  nodes: PywrNode[],
  kinds: RecorderKind[],
): { model: PywrModel; addedCount: number } {
  const recorders: Record<string, PywrRecorder> = { ...(model.recorders ?? {}) };
  let addedCount = 0;

  for (const node of nodes) {
    for (const kind of kinds) {
      if (!isRecorderApplicable(node, kind)) continue;
      const recType = recorderType(kind);
      if (recorderExists(recorders, recType, node.name)) continue;
      const name = uniqueRecorderName(recorders, `${node.name}_${recorderSuffix(kind)}`);
      recorders[name] = { type: recType, node: node.name } as PywrRecorder;
      addedCount += 1;
    }
  }

  if (addedCount === 0) return { model, addedCount };
  return { model: { ...model, recorders }, addedCount };
}

function isRecorderApplicable(node: PywrNode, kind: RecorderKind): boolean {
  const type = normalizeNodeType(node.type);
  if (kind === "storage" || kind === "normalisedStorage") {
    return STORAGE_NODE_TYPES.has(type);
  }
  if (kind === "deficit") {
    return type === "Output";
  }
  return type !== "AggregatedNode" && type !== "AggregatedStorage" && type !== "VirtualStorage";
}

function recorderType(kind: RecorderKind): string {
  switch (kind) {
    case "flow": return "NumpyArrayNodeRecorder";
    case "deficit": return "NumpyArrayNodeDeficitRecorder";
    case "storage": return "NumpyArrayStorageRecorder";
    case "normalisedStorage": return "NumpyArrayNormalisedStorageRecorder";
  }
}

function recorderSuffix(kind: RecorderKind): string {
  switch (kind) {
    case "flow": return "flow";
    case "deficit": return "deficit";
    case "storage": return "storage";
    case "normalisedStorage": return "normalised_storage";
  }
}

function recorderExists(recorders: Record<string, PywrRecorder>, recType: string, nodeName: string): boolean {
  return Object.values(recorders).some((rec) => {
    const obj = rec as unknown as Record<string, unknown>;
    return obj.type === recType && obj.node === nodeName;
  });
}

function uniqueRecorderName(recorders: Record<string, PywrRecorder>, base: string): string {
  const safeBase = base.replace(/[^\w.-]+/g, "_") || "recorder";
  if (!(safeBase in recorders)) return safeBase;
  let i = 2;
  while (`${safeBase}_${i}` in recorders) i += 1;
  return `${safeBase}_${i}`;
}

function segStyle(active: boolean, disabled: boolean): React.CSSProperties {
  return {
    border: "none",
    borderRadius: 4,
    padding: "6px 6px",
    fontSize: 11,
    fontWeight: 700,
    color: disabled ? "#94a3b8" : active ? "#0f172a" : "#475569",
    background: disabled ? "#f1f5f9" : active ? "#dbeafe" : "#f8fafc",
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

function buttonStyle(bg: string, width: number | string, disabled = false): React.CSSProperties {
  return {
    width,
    border: "none",
    borderRadius: 5,
    padding: "8px 10px",
    fontSize: 12,
    fontWeight: 800,
    color: "#fff",
    background: disabled ? "#94a3b8" : bg,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

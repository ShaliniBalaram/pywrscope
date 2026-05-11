// src/components/PropertiesPanel.tsx
// Right sidebar — shows all fields of the selected node as editable form inputs.
// Supports CSV parameter linking: click 📎 on a linkable field to bind it to
// a column in a CSV file, which creates a named CSVParameter in model.parameters.

import React, { useState, useEffect } from "react";
import { PywrNode } from "../types/pywr";

interface FieldDef {
  key: string;
  label: string;
  inputType: "text" | "number" | "checkbox" | "json-array";
  readOnly?: boolean;
  linkable?: boolean;  // shows 📎 CSV-link button
}

const ALL_NODE_TYPES = [
  "Input","Output","Link","LossLink","BreakLink","DelayNode",
  "Storage","Reservoir","VirtualStorage","AnnualVirtualStorage",
  "SeasonalVirtualStorage","MonthlyVirtualStorage","RollingVirtualStorage",
  "PiecewiseLink","MultiSplitLink","AggregatedNode","AggregatedStorage",
  "River","RiverGauge","Catchment","Discharge","RiverSplit","RiverSplitWithGauge",
  "KeatingAquifer",
];

// Field definitions per node type — derived from PYWR_SCHEMA.md
const FIELD_DEFS: Record<string, FieldDef[]> = {
  Input: [
    { key: "name",     label: "Name",     inputType: "text" },
    { key: "type",     label: "Type",     inputType: "text" },
    { key: "max_flow", label: "Max Flow", inputType: "text",   linkable: true },
    { key: "min_flow", label: "Min Flow", inputType: "text",   linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text",   linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  Output: [
    { key: "name",     label: "Name",     inputType: "text",   },
    { key: "type",     label: "Type",     inputType: "text",   },
    { key: "max_flow", label: "Max Flow", inputType: "text",   linkable: true },
    { key: "min_flow", label: "Min Flow", inputType: "text",   linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text",   linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  Link: [
    { key: "name",     label: "Name",     inputType: "text",   },
    { key: "type",     label: "Type",     inputType: "text",   },
    { key: "max_flow", label: "Max Flow", inputType: "text",   linkable: true },
    { key: "min_flow", label: "Min Flow", inputType: "text",   linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text",   linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  LossLink: [
    { key: "name",        label: "Name",        inputType: "text",   },
    { key: "type",        label: "Type",        inputType: "text",   },
    { key: "loss_factor", label: "Loss Factor", inputType: "text",   linkable: true },
    { key: "max_flow",    label: "Max Flow",    inputType: "text",   linkable: true },
    { key: "min_flow",    label: "Min Flow",    inputType: "text",   linkable: true },
    { key: "cost",        label: "Cost",        inputType: "text",   linkable: true },
    { key: "comment",     label: "Comment",     inputType: "text" },
  ],
  BreakLink: [
    { key: "name",     label: "Name",     inputType: "text",   },
    { key: "type",     label: "Type",     inputType: "text",   },
    { key: "max_flow", label: "Max Flow", inputType: "text",   linkable: true },
    { key: "min_flow", label: "Min Flow", inputType: "text",   linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text",   linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  DelayNode: [
    { key: "name",         label: "Name",         inputType: "text",   },
    { key: "type",         label: "Type",         inputType: "text",   },
    { key: "days",         label: "Delay (days)", inputType: "number" },
    { key: "initial_flow", label: "Initial Flow", inputType: "text",   linkable: true },
    { key: "comment",      label: "Comment",      inputType: "text" },
  ],
  Storage: [
    { key: "name",              label: "Name",              inputType: "text",   },
    { key: "type",              label: "Type",              inputType: "text",   },
    { key: "max_volume",        label: "Max Volume",        inputType: "number", linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "min_volume",        label: "Min Volume",        inputType: "number", linkable: true },
    { key: "cost",              label: "Cost",              inputType: "text",   linkable: true },
    { key: "level",             label: "Level",             inputType: "text",   linkable: true },
    { key: "area",              label: "Area",              inputType: "text",   linkable: true },
    { key: "num_inputs",        label: "Num Inputs",        inputType: "number" },
    { key: "num_outputs",       label: "Num Outputs",       inputType: "number" },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  Reservoir: [
    { key: "name",              label: "Name",              inputType: "text",   },
    { key: "type",              label: "Type",              inputType: "text",   },
    { key: "max_volume",        label: "Max Volume",        inputType: "text",   linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "min_volume",        label: "Min Volume",        inputType: "text",   linkable: true },
    { key: "cost",              label: "Cost",              inputType: "text",   linkable: true },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  VirtualStorage: [
    { key: "name",              label: "Name",              inputType: "text",       },
    { key: "type",              label: "Type",              inputType: "text",       },
    { key: "nodes",             label: "Nodes",             inputType: "json-array" },
    { key: "min_volume",        label: "Min Volume",        inputType: "number",     linkable: true },
    { key: "max_volume",        label: "Max Volume",        inputType: "number",     linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "cost",              label: "Cost",              inputType: "text",       linkable: true },
    { key: "factors",           label: "Factors",           inputType: "json-array" },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  AnnualVirtualStorage: [
    { key: "name",                    label: "Name",                  inputType: "text",       },
    { key: "type",                    label: "Type",                  inputType: "text",       },
    { key: "nodes",                   label: "Nodes",                 inputType: "json-array" },
    { key: "max_volume",              label: "Max Volume",            inputType: "number",     linkable: true },
    { key: "min_volume",              label: "Min Volume",            inputType: "number",     linkable: true },
    { key: "initial_volume",          label: "Initial Volume",        inputType: "number" },
    { key: "initial_volume_pc",       label: "Initial Volume %",      inputType: "number" },
    { key: "cost",                    label: "Cost",                  inputType: "text",       linkable: true },
    { key: "factors",                 label: "Factors",               inputType: "json-array" },
    { key: "reset_day",               label: "Reset Day",             inputType: "number" },
    { key: "reset_month",             label: "Reset Month",           inputType: "number" },
    { key: "reset_to_initial_volume", label: "Reset to Initial Vol.", inputType: "checkbox" },
    { key: "comment",                 label: "Comment",               inputType: "text" },
  ],
  SeasonalVirtualStorage: [
    { key: "name",              label: "Name",              inputType: "text",       },
    { key: "type",              label: "Type",              inputType: "text",       },
    { key: "nodes",             label: "Nodes",             inputType: "json-array" },
    { key: "max_volume",        label: "Max Volume",        inputType: "number",     linkable: true },
    { key: "min_volume",        label: "Min Volume",        inputType: "number",     linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "cost",              label: "Cost",              inputType: "text",       linkable: true },
    { key: "factors",           label: "Factors",           inputType: "json-array" },
    { key: "reset_day",         label: "Reset Day",         inputType: "number" },
    { key: "reset_month",       label: "Reset Month",       inputType: "number" },
    { key: "end_day",           label: "End Day",           inputType: "number" },
    { key: "end_month",         label: "End Month",         inputType: "number" },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  MonthlyVirtualStorage: [
    { key: "name",              label: "Name",              inputType: "text",       },
    { key: "type",              label: "Type",              inputType: "text",       },
    { key: "nodes",             label: "Nodes",             inputType: "json-array" },
    { key: "max_volume",        label: "Max Volume",        inputType: "number",     linkable: true },
    { key: "min_volume",        label: "Min Volume",        inputType: "number",     linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "cost",              label: "Cost",              inputType: "text",       linkable: true },
    { key: "factors",           label: "Factors",           inputType: "json-array" },
    { key: "months",            label: "Months",            inputType: "number" },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  RollingVirtualStorage: [
    { key: "name",              label: "Name",              inputType: "text",       },
    { key: "type",              label: "Type",              inputType: "text",       },
    { key: "nodes",             label: "Nodes",             inputType: "json-array" },
    { key: "max_volume",        label: "Max Volume",        inputType: "number",     linkable: true },
    { key: "min_volume",        label: "Min Volume",        inputType: "number",     linkable: true },
    { key: "initial_volume",    label: "Initial Volume",    inputType: "number" },
    { key: "initial_volume_pc", label: "Initial Volume %",  inputType: "number" },
    { key: "cost",              label: "Cost",              inputType: "text",       linkable: true },
    { key: "factors",           label: "Factors",           inputType: "json-array" },
    { key: "days",              label: "Rolling Days",      inputType: "number" },
    { key: "comment",           label: "Comment",           inputType: "text" },
  ],
  PiecewiseLink: [
    { key: "name",      label: "Name",       inputType: "text",       },
    { key: "type",      label: "Type",       inputType: "text",       },
    { key: "nsteps",    label: "Num Steps",  inputType: "number" },
    { key: "costs",     label: "Costs",      inputType: "json-array" },
    { key: "max_flows", label: "Max Flows",  inputType: "json-array" },
    { key: "comment",   label: "Comment",    inputType: "text" },
  ],
  MultiSplitLink: [
    { key: "name",       label: "Name",        inputType: "text",       },
    { key: "type",       label: "Type",        inputType: "text",       },
    { key: "nsteps",     label: "Num Steps",   inputType: "number" },
    { key: "extra_slots", label: "Extra Slots", inputType: "number" },
    { key: "costs",      label: "Costs",       inputType: "json-array" },
    { key: "max_flows",  label: "Max Flows",   inputType: "json-array" },
    { key: "comment",    label: "Comment",     inputType: "text" },
  ],
  AggregatedNode: [
    { key: "name",     label: "Name",     inputType: "text",       },
    { key: "type",     label: "Type",     inputType: "text",       },
    { key: "nodes",    label: "Nodes",    inputType: "json-array" },
    { key: "min_flow", label: "Min Flow", inputType: "text",       linkable: true },
    { key: "max_flow", label: "Max Flow", inputType: "text",       linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text",       linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  AggregatedStorage: [
    { key: "name",     label: "Name",     inputType: "text",       },
    { key: "type",     label: "Type",     inputType: "text",       },
    { key: "storages", label: "Storages", inputType: "json-array" },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  River: [
    { key: "name",     label: "Name",     inputType: "text", },
    { key: "type",     label: "Type",     inputType: "text", },
    { key: "max_flow", label: "Max Flow", inputType: "text", linkable: true },
    { key: "min_flow", label: "Min Flow", inputType: "text", linkable: true },
    { key: "cost",     label: "Cost",     inputType: "text", linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  RiverGauge: [
    { key: "name",     label: "Name",     inputType: "text",   },
    { key: "type",     label: "Type",     inputType: "text",   },
    { key: "mrf",      label: "MRF",      inputType: "number", linkable: true },
    { key: "cost",     label: "Cost",     inputType: "number", linkable: true },
    { key: "mrf_cost", label: "MRF Cost", inputType: "number", linkable: true },
    { key: "comment",  label: "Comment",  inputType: "text" },
  ],
  Catchment: [
    { key: "name",    label: "Name",    inputType: "text", },
    { key: "type",    label: "Type",    inputType: "text", },
    { key: "flow",    label: "Flow",    inputType: "text", linkable: true },
    { key: "cost",    label: "Cost",    inputType: "text", linkable: true },
    { key: "comment", label: "Comment", inputType: "text" },
  ],
  Discharge: [
    { key: "name",    label: "Name",    inputType: "text", },
    { key: "type",    label: "Type",    inputType: "text", },
    { key: "flow",    label: "Flow",    inputType: "text", linkable: true },
    { key: "cost",    label: "Cost",    inputType: "text", linkable: true },
    { key: "comment", label: "Comment", inputType: "text" },
  ],
  RiverSplit: [
    { key: "name",       label: "Name",       inputType: "text",       },
    { key: "type",       label: "Type",       inputType: "text",       },
    { key: "factors",    label: "Factors",    inputType: "json-array" },
    { key: "slot_names", label: "Slot Names", inputType: "json-array" },
    { key: "cost",       label: "Cost",       inputType: "text",       linkable: true },
    { key: "comment",    label: "Comment",    inputType: "text" },
  ],
  RiverSplitWithGauge: [
    { key: "name",       label: "Name",       inputType: "text",       },
    { key: "type",       label: "Type",       inputType: "text",       },
    { key: "mrf",        label: "MRF",        inputType: "number",     linkable: true },
    { key: "cost",       label: "Cost",       inputType: "number",     linkable: true },
    { key: "mrf_cost",   label: "MRF Cost",   inputType: "number",     linkable: true },
    { key: "factors",    label: "Factors",    inputType: "json-array" },
    { key: "slot_names", label: "Slot Names", inputType: "json-array" },
    { key: "comment",    label: "Comment",    inputType: "text" },
  ],
  KeatingAquifer: [
    { key: "name",                   label: "Name",                    inputType: "text",   },
    { key: "type",                   label: "Type",                    inputType: "text",   },
    { key: "num_streams",            label: "Num Streams",             inputType: "number" },
    { key: "num_additional_inputs",  label: "Num Additional Inputs",   inputType: "number" },
    { key: "comment",                label: "Comment",                 inputType: "text" },
  ],
};

interface PropertiesPanelProps {
  node: PywrNode;
  onUpdate: (updates: Partial<PywrNode>) => void;
  onRename: (newName: string) => void;
  onLinkCsv?: (fieldKey: string, csvPath: string, column: string) => void;
}

interface FieldRowProps {
  fieldDef: FieldDef;
  value: unknown;
  onCommit: (key: string, value: unknown) => void;
  onLinkCsv?: (csvPath: string, column: string) => void;
}

// State for inline CSV column picker
interface CsvPickState {
  csvPath: string;
  columns: string[];
  selectedColumn: string;
}

function FieldRow({ fieldDef, value, onCommit, onLinkCsv }: FieldRowProps) {
  const [localValue, setLocalValue] = useState<string>(
    fieldDef.inputType === "json-array"
      ? JSON.stringify(value ?? [])
      : String(value ?? "")
  );
  const [error, setError] = useState<string | null>(null);
  const [csvPick, setCsvPick] = useState<CsvPickState | null>(null);

  // Sync when external value changes (e.g. undo)
  useEffect(() => {
    setLocalValue(
      fieldDef.inputType === "json-array"
        ? JSON.stringify(value ?? [])
        : String(value ?? "")
    );
    setError(null);
    setCsvPick(null);
  }, [value, fieldDef.inputType]);

  function handleBlur() {
    if (fieldDef.readOnly) return;
    const trimmed = localValue.trim();

    if (fieldDef.inputType === "number") {
      if (trimmed === "") {
        onCommit(fieldDef.key, undefined);
        setError(null);
        return;
      }
      const n = Number(trimmed);
      if (isNaN(n)) {
        setError("Must be a number");
        return;
      }
      setError(null);
      onCommit(fieldDef.key, n);
      return;
    }

    if (fieldDef.inputType === "json-array") {
      try {
        const parsed = JSON.parse(trimmed || "[]");
        if (!Array.isArray(parsed)) {
          setError("Must be a JSON array");
          return;
        }
        setError(null);
        onCommit(fieldDef.key, parsed);
      } catch {
        setError("Invalid JSON array");
      }
      return;
    }

    setError(null);
    onCommit(fieldDef.key, trimmed === "" ? undefined : trimmed);
  }

  async function handleCsvLink() {
    const csvPath = await window.pywr.openCsv();
    if (!csvPath) return;
    const columns = await window.pywr.readCsvColumns(csvPath);
    if (!columns.length) return;
    setCsvPick({ csvPath, columns, selectedColumn: columns[0] });
  }

  function confirmCsvLink() {
    if (!csvPick || !onLinkCsv) return;
    onLinkCsv(csvPick.csvPath, csvPick.selectedColumn);
    setCsvPick(null);
  }

  if (fieldDef.inputType === "checkbox") {
    return (
      <div style={rowStyle}>
        <label style={labelStyle}>{fieldDef.label}</label>
        <input
          type="checkbox"
          checked={Boolean(value)}
          disabled={fieldDef.readOnly}
          onChange={(e) => {
            if (!fieldDef.readOnly) onCommit(fieldDef.key, e.target.checked);
          }}
          style={{ marginTop: 2 }}
        />
      </div>
    );
  }

  // CSV column picker overlay
  if (csvPick) {
    return (
      <div style={{ ...rowStyle, flexDirection: "column", alignItems: "stretch", gap: 4 }}>
        <label style={{ ...labelStyle, textAlign: "left", width: "auto" }}>{fieldDef.label} — link CSV</label>
        <select
          value={csvPick.selectedColumn}
          onChange={(e) => setCsvPick({ ...csvPick, selectedColumn: e.target.value })}
          style={{ fontSize: 11, padding: "2px 4px", borderRadius: 3, border: "1px solid #ccc" }}
        >
          {csvPick.columns.map((col) => (
            <option key={col} value={col}>{col}</option>
          ))}
        </select>
        <div style={{ display: "flex", gap: 4 }}>
          <button
            onClick={confirmCsvLink}
            style={{ flex: 1, fontSize: 10, padding: "2px 6px", cursor: "pointer",
              backgroundColor: "#2980b9", color: "#fff", border: "none", borderRadius: 3 }}
          >
            Link
          </button>
          <button
            onClick={() => setCsvPick(null)}
            style={{ fontSize: 10, padding: "2px 6px", cursor: "pointer",
              backgroundColor: "#ccc", color: "#444", border: "none", borderRadius: 3 }}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={rowStyle}>
      <label style={labelStyle}>{fieldDef.label}</label>
      <div style={{ flex: 1 }}>
        <div style={{ display: "flex", gap: 3, alignItems: "center" }}>
          <input
            type="text"
            value={localValue}
            readOnly={fieldDef.readOnly}
            disabled={fieldDef.readOnly}
            onChange={(e) => setLocalValue(e.target.value)}
            onBlur={handleBlur}
            style={{
              flex: 1,
              boxSizing: "border-box",
              padding: "3px 6px",
              border: error ? "1px solid #c0392b" : "1px solid #ccc",
              borderRadius: 3,
              fontSize: 11,
              backgroundColor: fieldDef.readOnly ? "#f0f0f0" : "#fff",
              color: fieldDef.readOnly ? "#777" : "#222",
              minWidth: 0,
            }}
          />
          {fieldDef.linkable && !fieldDef.readOnly && onLinkCsv && (
            <button
              onClick={handleCsvLink}
              title="Link to CSV column"
              style={{
                fontSize: 11, padding: "2px 4px", cursor: "pointer",
                backgroundColor: "transparent", border: "1px solid #ccc",
                borderRadius: 3, color: "#555", flexShrink: 0,
              }}
            >
              📎
            </button>
          )}
        </div>
        {error && (
          <div style={{ color: "#c0392b", fontSize: 10, marginTop: 2 }}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

const rowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  marginBottom: 6,
  gap: 6,
};

const labelStyle: React.CSSProperties = {
  width: 90,
  minWidth: 90,
  fontSize: 10,
  color: "#555",
  paddingTop: 4,
  fontWeight: "bold",
  textAlign: "right",
};

export function PropertiesPanel({ node, onUpdate, onRename, onLinkCsv }: PropertiesPanelProps) {
  const fields = FIELD_DEFS[node.type] ?? [
    { key: "name", label: "Name", inputType: "text" as const },
    { key: "type", label: "Type", inputType: "text" as const },
  ];

  function handleCommit(key: string, value: unknown) {
    if (key === "name") {
      const newName = String(value ?? "").trim();
      if (newName && newName !== node.name) onRename(newName);
      return;
    }
    onUpdate({ [key]: value } as Partial<PywrNode>);
  }

  return (
    <div
      style={{
        width: 240,
        minWidth: 240,
        backgroundColor: "#fafafa",
        borderLeft: "1px solid #ddd",
        overflowY: "auto",
        padding: "12px 10px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          fontSize: 11,
          fontWeight: "bold",
          color: "#333",
          marginBottom: 10,
          borderBottom: "1px solid #ddd",
          paddingBottom: 6,
        }}
      >
        Properties
        <span
          style={{
            fontSize: 10,
            color: "#888",
            fontWeight: "normal",
            marginLeft: 6,
          }}
        >
          {node.type}
        </span>
      </div>

      {fields.map((fd) => {
        if (fd.key === "type") {
          return (
            <div key="type" style={rowStyle}>
              <label style={labelStyle}>Type</label>
              <select
                value={node.type}
                onChange={e => onUpdate({ type: e.target.value } as Partial<PywrNode>)}
                style={{ flex: 1, fontSize: 11, padding: "3px 6px", borderRadius: 3, border: "1px solid #ccc", backgroundColor: "#fff", color: "#222" }}
              >
                {ALL_NODE_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          );
        }
        return (
          <FieldRow
            key={fd.key}
            fieldDef={fd}
            value={(node as unknown as Record<string, unknown>)[fd.key]}
            onCommit={handleCommit}
            onLinkCsv={
              fd.linkable && onLinkCsv
                ? (csvPath, column) => onLinkCsv(fd.key, csvPath, column)
                : undefined
            }
          />
        );
      })}
    </div>
  );
}

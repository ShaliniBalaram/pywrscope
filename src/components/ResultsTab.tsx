// src/components/ResultsTab.tsx
// Results tab — for a clicked node, trace forward through edges to every
// reachable Output-type sink, then cross-reference with recorders + the last
// run's summary.json to show which sinks have active (non-zero) recorded flow.
//
// Why this exists: the generic ResultsViewer modal shows raw CSV/HDF5 tables,
// which doesn't answer "where does flow from THIS node end up?" — a question
// engineers actually ask while reading a network. This tab is purpose-built
// for that question and nothing else.
//
// Data sources:
//   - model.edges            : directed adjacency for the BFS
//   - model.nodes            : type lookup (we only call type==="Output" a sink)
//   - model.recorders        : maps recorder name → node name (NumpyArrayNodeRecorder.node)
//   - run.outputs[summary]   : summary.json, written by run_pywr.py; per-recorder
//                              aggregate flow keyed by recorder name
//
// "Active" means the aggregated recorder value is non-zero (|v| > 1e-9). Without
// a completed run there's no flow data, so the panel falls back to listing
// reachable sinks topologically — still useful for sanity-checking connections.

import React, { useMemo, useState } from "react";
import type { PywrModel } from "../types/pywr";
import { isNodeBoundRecorder } from "../types/pywr";
import type { RunStateView } from "../hooks/useModelRun";
import type { RunResultsView } from "../hooks/useRunResults";
import { normalizeNodeType } from "../constants/nodeTypes";
import {
  NodeTimeSeriesChart,
  type ChartRecorderRef,
  type ChartRefLine,
} from "./NodeTimeSeriesChart";
import { RecorderStatsStrip } from "./RecorderStatsStrip";
import { ZeroFlowAnalyzer } from "./ZeroFlowAnalyzer";
import { MassBalanceAudit } from "./MassBalanceAudit";
import { FlowDurationCurve } from "./FlowDurationCurve";
import { ReliabilityDashboard } from "./ReliabilityDashboard";
import { DeficitEvents } from "./DeficitEvents";
import { ConcurrentFailureChart } from "./ConcurrentFailureChart";
import { SourceAttribution } from "./SourceAttribution";
import { SankeyView } from "./SankeyView";

// The Results tab hosts eight sibling views over the same run data:
//   - "downstream"   : the original per-node drilldown (chart + sink list)
//   - "zero-flow"    : the network-wide zero-day rank (T1.3)
//   - "mass-balance" : whole-system Σ inputs vs Σ outputs audit (T1.4)
//   - "reliability"  : per-Output deficit / reliability league table (T2.7)
//   - "events"       : EDO-style consecutive-deficit event log (T3.8)
//   - "concurrent"   : cross-network concurrent-failure timeseries + heatmap (T3.9)
//   - "sources"      : reverse attribution — which sources fed THIS sink (T3.10)
//   - "sankey"       : annual network Sankey from per-edge LP route flows (T2.5)
// All share the left node picker so jumping between them keeps the user's
// "selected node" anchored — clicking a row in any whole-network view
// auto-switches back to downstream for that node.
type ResultsView =
  | "downstream"
  | "zero-flow"
  | "mass-balance"
  | "reliability"
  | "events"
  | "concurrent"
  | "sources"
  | "sankey";

interface ResultsTabProps {
  model: PywrModel | null;
  runState: RunStateView;
  // Loaded summary.json + derived per-node flow. App owns the hook so the
  // canvas and this tab agree on what counts as "active" for the same run.
  runResults: RunResultsView;
  selectedNodeName: string | null;
  onSelectNode: (name: string) => void;
}

interface RecorderEntry {
  recorderName: string;
  node: string | null;
  type: string;
}

// Per-recorder row carried into the downstream panel. Wider than RecorderEntry
// because the panel needs both the summary aggregate (for the headline
// "value =" line) and the CSV path (for the per-recorder stats strip).
interface OutputRecorderEntry {
  recorderName: string;
  type: string;
  aggValue: number | null;
  csvPath: string | null;
}

// One downstream Output and the recorders bound to it. Hoisted to a named
// type so the panel and row props can share it without re-declaring the
// shape three times.
interface DownstreamOutput {
  name: string;
  type: string;
  recorders: OutputRecorderEntry[];
}

// Pull recorder-name → node-name pairs out of the model. We only care about
// node recorders here (NumpyArrayNodeRecorder, NumpyArrayNodeDeficitRecorder,
// NumpyArrayStorageRecorder, NumpyArrayNormalisedStorageRecorder) — parameter
// recorders don't bind to a graph node so they can't answer "is flow active
// at this sink".
function readRecorders(model: PywrModel | null): RecorderEntry[] {
  if (!model?.recorders) return [];
  const out: RecorderEntry[] = [];
  for (const [recName, rec] of Object.entries(model.recorders)) {
    if (!isNodeBoundRecorder(rec)) continue;
    out.push({
      recorderName: recName,
      type: rec.type,
      node: rec.node,
    });
  }
  return out;
}

// Forward BFS from `source` collecting every node reachable along edge
// direction. Excludes the source itself so the caller can render "downstream
// from X" without X showing up in its own list.
function reachableFrom(source: string, edges: PywrModel["edges"]): Set<string> {
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    const from = e[0];
    const to = e[1];
    const list = adj.get(from);
    if (list) list.push(to);
    else adj.set(from, [to]);
  }
  const seen = new Set<string>();
  const queue: string[] = [source];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of adj.get(cur) ?? []) {
      if (!seen.has(next)) queue.push(next);
    }
  }
  seen.delete(source);
  return seen;
}

const ACTIVE_EPS = 1e-9;
const MAIN_RESULT_NODE_TOKENS = new Set(["GW", "WTW", "DC", "BST", "NRV"]);

function nodeTokens(node: PywrModel["nodes"][number]): Set<string> {
  return new Set(
    `${node.name} ${node.type}`
      .toUpperCase()
      .split(/[^A-Z0-9]+/)
      .filter(Boolean),
  );
}

function isMainResultNode(node: PywrModel["nodes"][number]): boolean {
  const tokens = nodeTokens(node);
  for (const token of MAIN_RESULT_NODE_TOKENS) {
    if (tokens.has(token)) return true;
  }
  return false;
}

export function ResultsTab({
  model,
  runState,
  runResults,
  selectedNodeName,
  onSelectNode,
}: ResultsTabProps) {
  const recAgg = runResults.recAgg;
  const error = runResults.error;
  const recorders = useMemo(() => readRecorders(model), [model]);

  // outputPathByRecorder — recorder name → CSV path on disk. Built from the
  // run's `done` event, which already pairs each non-summary entry with the
  // recorder that produced it. Recorders that produced no CSV (aggregate-only)
  // are absent from this map; the chart treats that as "no per-step file".
  // Built ahead of nodeRecorderMap so the latter can attach csvPath inline —
  // OutputRow needs the path to render its stats strip.
  const outputPathByRecorder = useMemo(() => {
    const m = new Map<string, string>();
    for (const o of runState.outputs) {
      if (o.name === "summary") continue;
      m.set(o.name, o.path);
    }
    return m;
  }, [runState.outputs]);

  // node-name → list of (recorder, aggregated value, csvPath, type). One node
  // can have multiple recorders (e.g. an Output with both a flow and a deficit
  // recorder). csvPath + type are carried alongside aggValue so the downstream
  // panel can render a stats strip per recorder without re-traversing the
  // recorders list.
  const nodeRecorderMap = useMemo(() => {
    const m = new Map<string, OutputRecorderEntry[]>();
    for (const r of recorders) {
      if (!r.node) continue;
      const v = recAgg?.[r.recorderName];
      const list = m.get(r.node) ?? [];
      list.push({
        recorderName: r.recorderName,
        type: r.type,
        aggValue: typeof v === "number" ? v : null,
        csvPath: outputPathByRecorder.get(r.recorderName) ?? null,
      });
      m.set(r.node, list);
    }
    return m;
  }, [recorders, recAgg, outputPathByRecorder]);

  const reachable = useMemo(() => {
    if (!model || !selectedNodeName) return new Set<string>();
    return reachableFrom(selectedNodeName, model.edges);
  }, [model, selectedNodeName]);

  // The selected node's recorders, paired with their CSV path. Used by the
  // time-series chart. Distinct from `nodeRecorderMap` (which carries
  // aggregate values for the downstream-sinks list) because the chart needs
  // file paths, not aggregates.
  const selectedNodeRecorders = useMemo<ChartRecorderRef[]>(() => {
    if (!selectedNodeName) return [];
    const out: ChartRecorderRef[] = [];
    for (const r of recorders) {
      if (r.node !== selectedNodeName) continue;
      out.push({
        recorderName: r.recorderName,
        type: r.type,
        csvPath: outputPathByRecorder.get(r.recorderName) ?? null,
      });
    }
    return out;
  }, [recorders, selectedNodeName, outputPathByRecorder]);

  // Reference lines for the chart — only numeric node fields. Parameter
  // references (strings like "demand_profile") are skipped; we'd need to
  // resolve the parameter per timestep, which is out of scope for T1.1.
  const selectedNodeRefLines = useMemo<ChartRefLine[]>(() => {
    if (!model || !selectedNodeName) return [];
    const node = model.nodes.find((n) => n.name === selectedNodeName);
    if (!node) return [];
    const out: ChartRefLine[] = [];
    const push = (label: string, raw: unknown, color: string) => {
      if (typeof raw === "number" && Number.isFinite(raw)) {
        out.push({ label, value: raw, color });
      }
    };
    // `node as Record<string, unknown>` because PywrNode is a discriminated
    // union and not all variants carry these fields — we tolerate `undefined`.
    const fields = node as unknown as Record<string, unknown>;
    push("max_flow", fields.max_flow, "#dc2626");
    push("min_flow", fields.min_flow, "#2563eb");
    push("cost", fields.cost, "#7c3aed");
    return out;
  }, [model, selectedNodeName]);

  // Downstream Output-type nodes only — those are the flow sinks in Pywr.
  const downstreamOutputs = useMemo<DownstreamOutput[]>(() => {
    if (!model || !selectedNodeName) return [];
    const out: DownstreamOutput[] = [];
    for (const n of model.nodes) {
      if (!reachable.has(n.name)) continue;
      // Pywr JSON accepts case variants like "output"/"Output" — normalize
      // before the type check so real-world models work.
      if (normalizeNodeType(n.type) !== "Output") continue;
      out.push({
        name: n.name,
        type: n.type,
        recorders: nodeRecorderMap.get(n.name) ?? [],
      });
    }
    return out;
  }, [model, selectedNodeName, reachable, nodeRecorderMap]);

  if (!model) {
    return (
      <div style={emptyStyle}>
        Open a model to see results.
      </div>
    );
  }

  const hasRun = runState.status === "done";
  // View state lives here, not lifted to App, because it's purely a Results-tab
  // concern. Lifting would mean App tracks state it never references. Default
  // is "downstream" — same UX as before the analyzer existed, so users who
  // never click the toggle see the familiar view.
  const [view, setView] = useState<ResultsView>("downstream");
  const [showAllNodes, setShowAllNodes] = useState(false);
  const visibleNodes = useMemo(() => {
    if (showAllNodes) return model.nodes;
    const main = model.nodes.filter(isMainResultNode);
    if (selectedNodeName && !main.some((n) => n.name === selectedNodeName)) {
      const selected = model.nodes.find((n) => n.name === selectedNodeName);
      if (selected) return [selected, ...main];
    }
    return main.length > 0 ? main : model.nodes;
  }, [model.nodes, selectedNodeName, showAllNodes]);

  return (
    <div style={{ display: "flex", flex: 1, overflow: "hidden", backgroundColor: "#f8fafc" }}>
      {/* Left — node picker. Same list works whether or not a run has happened
          so users can still trace topology without results data. */}
      <div style={{
        width: 280, flexShrink: 0, borderRight: "1px solid #e2e8f0",
        overflow: "auto", backgroundColor: "#fff",
      }}>
        <div style={{
          padding: "10px 14px 4px 14px", fontSize: 11, color: "#64748b",
          textTransform: "uppercase", letterSpacing: 0.5, fontWeight: 700,
        }}>
          {showAllNodes ? "All nodes" : "Main nodes"} ({visibleNodes.length}/{model.nodes.length})
        </div>
        <div style={{ display: "flex", gap: 6, padding: "0 14px 10px 14px" }}>
          <button
            onClick={() => setShowAllNodes(false)}
            style={smallToggleStyle(!showAllNodes)}
          >
            GW WTW DC BST NRV
          </button>
          <button
            onClick={() => setShowAllNodes(true)}
            style={smallToggleStyle(showAllNodes)}
          >
            All
          </button>
        </div>
        {visibleNodes.map((n) => {
          const sel = n.name === selectedNodeName;
          return (
            <button
              key={n.name}
              onClick={() => {
                // Picking a node from the sidebar implies the user wants the
                // per-node view, so switch back from zero-flow if needed.
                // Without this, clicking a node in zero-flow mode would
                // silently update selectedNodeName with no visible effect.
                onSelectNode(n.name);
                if (view !== "downstream") setView("downstream");
              }}
              title={n.name}
              style={{
                display: "block", width: "100%", textAlign: "left",
                padding: "6px 14px",
                border: "none",
                borderLeft: sel ? "3px solid #1d4ed8" : "3px solid transparent",
                background: sel ? "#dbeafe" : "transparent",
                cursor: "pointer",
                fontSize: 12,
                color: "#0f172a",
                borderBottom: "1px solid #f1f5f9",
              }}
            >
              <div style={{
                fontWeight: sel ? 700 : 500,
                overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {n.name}
              </div>
              <div style={{ fontSize: 10, color: "#64748b" }}>{n.type}</div>
            </button>
          );
        })}
      </div>

      {/* Right — view toggle + active view. Pulled into a single flex column
          so the toggle sticks to the top while the inner view scrolls. */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <ViewToggle
          view={view}
          onChange={setView}
          // The zero-flow view depends on a completed run for CSV paths. We
          // disable the tab pre-run rather than hide it so users know it
          // exists and that running the model will unlock it.
          zeroFlowDisabled={!hasRun}
        />

        {view === "downstream" && (
          <div style={{ flex: 1, overflow: "auto", padding: 20 }}>
            {!selectedNodeName && (
              <div style={emptyStyle}>
                Select a node on the left to trace its downstream Output nodes.
              </div>
            )}
            {selectedNodeName && (
              <>
                {/* Time-series chart sits above the topology view because the
                    chart answers "what does THIS node do?" while the downstream
                    panel answers "where does its flow end up?". Ordering
                    follows the question users ask first. Chart is only
                    meaningful after a completed run — before that we suppress
                    it entirely rather than render an empty frame. */}
                {hasRun && (
                  <NodeTimeSeriesChart
                    nodeName={selectedNodeName}
                    recorders={selectedNodeRecorders}
                    refLines={selectedNodeRefLines}
                  />
                )}
                {/* Flow-duration curve sits between the time-series and the
                    downstream-sinks list because it answers the same
                    "what happens at this node?" question with a different
                    framing (percentile rather than chronology). */}
                {hasRun && (
                  <FlowDurationCurve
                    nodeName={selectedNodeName}
                    recorders={selectedNodeRecorders}
                  />
                )}
                <DownstreamPanel
                  selectedName={selectedNodeName}
                  outputs={downstreamOutputs}
                  hasRun={hasRun}
                  runStatus={runState.status}
                  error={error}
                />
              </>
            )}
          </div>
        )}

        {view === "zero-flow" && hasRun && (
          <ZeroFlowAnalyzer
            model={model}
            runState={runState}
            onSelectNode={(name) => {
              // Click-through from the rank view jumps back to per-node so
              // the user can drill into the offending node immediately.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "mass-balance" && hasRun && (
          <MassBalanceAudit
            model={model}
            runState={runState}
            onSelectNode={(name) => {
              // Worst-day click jumps to the per-node drilldown for the
              // candidate sink so the user lands on the suspected culprit.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "reliability" && hasRun && (
          <ReliabilityDashboard
            model={model}
            runState={runState}
            onSelectNode={(name) => {
              // League-table row click → per-node downstream view so the
              // user can inspect the time series of the failing demand.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "events" && hasRun && (
          <DeficitEvents
            model={model}
            runState={runState}
            onSelectNode={(name) => {
              // Event row click → per-node downstream view so the user can
              // see the affected timeline visually next to the chart.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "concurrent" && hasRun && (
          <ConcurrentFailureChart
            model={model}
            runState={runState}
            onSelectNode={(name) => {
              // Row-label click on the heatmap → per-node Downstream view.
              // The label is the only click target inside the cross-network
              // view because the cells themselves carry per-day state, not
              // per-node identity.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "sources" && hasRun && (
          <SourceAttribution
            model={model}
            runResults={runResults}
            selectedNodeName={selectedNodeName}
            onSelectNode={(name) => {
              // Source-row click → per-node Downstream view of that source,
              // so the user can drill into its time series and downstream
              // reach. Doesn't reset the original sink selection because the
              // user might bounce back-and-forth.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}

        {view === "sankey" && hasRun && (
          <SankeyView
            runState={runState}
            onSelectNode={(name) => {
              // Click a Sankey node bar / label → Downstream view of that
              // node. Same UX rule as the other cross-network views.
              onSelectNode(name);
              setView("downstream");
            }}
          />
        )}
      </div>
    </div>
  );
}

// Sub-tab strip — three pills at the top of the right panel. Pure
// presentation; owns no state of its own. The two run-dependent buttons
// share the same `disabled` signal because both need a completed run for
// their CSV data.
function ViewToggle({
  view,
  onChange,
  zeroFlowDisabled,
}: {
  view: ResultsView;
  onChange: (v: ResultsView) => void;
  zeroFlowDisabled: boolean;
}) {
  return (
    <div style={{
      display: "flex", gap: 4, padding: "8px 16px", borderBottom: "1px solid #e2e8f0",
      background: "#fff", flexShrink: 0,
    }}>
      <ToggleButton
        active={view === "downstream"}
        onClick={() => onChange("downstream")}
        disabled={false}
        label="Downstream"
        title="Per-node drilldown: chart + downstream Output sinks"
      />
      <ToggleButton
        active={view === "zero-flow"}
        onClick={() => onChange("zero-flow")}
        disabled={zeroFlowDisabled}
        label="Zero-flow rank"
        title={
          zeroFlowDisabled
            ? "Run the model first — zero-flow analysis needs the per-recorder CSVs"
            : "Network-wide rank of nodes by zero-flow day count"
        }
      />
      <ToggleButton
        active={view === "mass-balance"}
        onClick={() => onChange("mass-balance")}
        disabled={zeroFlowDisabled}
        label="Mass balance"
        title={
          zeroFlowDisabled
            ? "Run the model first — mass-balance audit needs the per-recorder CSVs"
            : "Σ inputs vs Σ outputs (annual + per-step), with LP violation flagging"
        }
      />
      <ToggleButton
        active={view === "reliability"}
        onClick={() => onChange("reliability")}
        disabled={zeroFlowDisabled}
        label="Reliability"
        title={
          zeroFlowDisabled
            ? "Run the model first — reliability needs the per-recorder CSVs"
            : "Per-Output deficit & reliability league table, sorted worst → best"
        }
      />
      <ToggleButton
        active={view === "events"}
        onClick={() => onChange("events")}
        disabled={zeroFlowDisabled}
        label="Events"
        title={
          zeroFlowDisabled
            ? "Run the model first — events log needs the per-recorder CSVs"
            : "Consecutive-deficit drought event log with per-DC severity strip"
        }
      />
      <ToggleButton
        active={view === "concurrent"}
        onClick={() => onChange("concurrent")}
        disabled={zeroFlowDisabled}
        label="Concurrent"
        title={
          zeroFlowDisabled
            ? "Run the model first — concurrent-failure analysis needs the per-recorder CSVs"
            : "Cross-network concurrent-deficit timeseries + Output × date heatmap"
        }
      />
      <ToggleButton
        active={view === "sources"}
        onClick={() => onChange("sources")}
        disabled={zeroFlowDisabled}
        label="Sources"
        title={
          zeroFlowDisabled
            ? "Run the model first — source attribution needs aggregate flow data"
            : "Reverse attribution: fraction of selected sink's flow originating at each upstream source"
        }
      />
      <ToggleButton
        active={view === "sankey"}
        onClick={() => onChange("sankey")}
        disabled={zeroFlowDisabled}
        label="Sankey"
        title={
          zeroFlowDisabled
            ? "Run the model first — Sankey needs per-edge LP route flows from a completed run"
            : "Annual network Sankey: per-edge aggregated flows captured from the LP solver"
        }
      />
    </div>
  );
}

function ToggleButton({
  active, onClick, disabled, label, title,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  label: string;
  title: string;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      title={title}
      style={{
        padding: "6px 14px",
        fontSize: 12,
        fontWeight: active ? 700 : 500,
        color: disabled ? "#cbd5e1" : active ? "#1d4ed8" : "#475569",
        background: active ? "#dbeafe" : "transparent",
        border: "1px solid",
        borderColor: active ? "#93c5fd" : "#e2e8f0",
        borderRadius: 6,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {label}
    </button>
  );
}

function smallToggleStyle(active: boolean): React.CSSProperties {
  return {
    padding: "4px 8px",
    border: "1px solid",
    borderColor: active ? "#93c5fd" : "#e2e8f0",
    borderRadius: 5,
    background: active ? "#dbeafe" : "#fff",
    color: active ? "#1d4ed8" : "#475569",
    fontSize: 10,
    fontWeight: active ? 700 : 500,
    cursor: "pointer",
    whiteSpace: "nowrap",
  };
}

function DownstreamPanel({
  selectedName,
  outputs,
  hasRun,
  runStatus,
  error,
}: {
  selectedName: string;
  outputs: DownstreamOutput[];
  hasRun: boolean;
  runStatus: RunStateView["status"];
  error: string | null;
}) {
  // Split into active vs inactive only when we have a completed run. Before
  // that, "active" is meaningless — we just list reachable sinks.
  const activeOutputs = hasRun
    ? outputs.filter((o) =>
        o.recorders.some((r) => r.aggValue !== null && Math.abs(r.aggValue) > ACTIVE_EPS)
      )
    : [];
  const inactiveOutputs = hasRun
    ? outputs.filter((o) => !activeOutputs.includes(o))
    : [];

  return (
    <div>
      <div style={{ fontSize: 14, color: "#0f172a", marginBottom: 4, fontWeight: 600 }}>
        Downstream from <span style={{ color: "#1d4ed8" }}>{selectedName}</span>
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 14 }}>
        {outputs.length} Output node{outputs.length === 1 ? "" : "s"} reachable along edges.
        {!hasRun && (
          <>{" "}<span style={{ color: "#a16207" }}>Run the model to see active flow values.</span></>
        )}
      </div>

      {runStatus === "running" || runStatus === "starting" ? (
        <div style={statusBox("#dbeafe", "#1d4ed8")}>
          Run in progress — flow values will appear here when it finishes.
        </div>
      ) : null}

      {runStatus === "error" && (
        <div style={statusBox("#fef2f2", "#991b1b")}>
          The last run failed — flow values aren't available. Fix the run error and try again.
        </div>
      )}

      {error && (
        <div style={statusBox("#fef2f2", "#991b1b")}>
          Couldn't read summary.json: {error}
        </div>
      )}

      {outputs.length === 0 && (
        <div style={{
          padding: 14, background: "#f1f5f9", borderRadius: 6,
          color: "#475569", fontSize: 12,
        }}>
          No Output-type sinks are reachable from <strong>{selectedName}</strong>.
          {" "}Either there are no edges leading to an Output node, or this node is
          downstream of every sink. Add edges on the Canvas tab to connect it to one.
        </div>
      )}

      {hasRun && activeOutputs.length > 0 && (
        <Section title={`Active flows (${activeOutputs.length})`} color="#059669">
          {activeOutputs.map((o) => (
            <OutputRow key={o.name} output={o} state="active" />
          ))}
        </Section>
      )}

      {hasRun && inactiveOutputs.length > 0 && (
        <Section title={`Inactive / unrecorded (${inactiveOutputs.length})`} color="#64748b">
          {inactiveOutputs.map((o) => (
            <OutputRow key={o.name} output={o} state="inactive" />
          ))}
        </Section>
      )}

      {!hasRun && outputs.length > 0 && (
        <Section title="Reachable Output nodes" color="#3B8BD4">
          {outputs.map((o) => (
            <OutputRow key={o.name} output={o} state="unknown" />
          ))}
        </Section>
      )}
    </div>
  );
}

function Section({
  title, color, children,
}: { title: string; color: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{
        fontSize: 11, color, textTransform: "uppercase", letterSpacing: 0.5,
        marginBottom: 6, fontWeight: 700,
      }}>
        {title}
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {children}
      </div>
    </div>
  );
}

function OutputRow({
  output,
  state,
}: {
  output: DownstreamOutput;
  state: "active" | "inactive" | "unknown";
}) {
  const dot =
    state === "active" ? "#10b981" :
    state === "inactive" ? "#cbd5e1" :
    "#3B8BD4";
  const stateLabel =
    state === "active" ? "ACTIVE" :
    state === "inactive" ? "—" :
    "RUN PENDING";
  return (
    <div style={{
      display: "flex", alignItems: "flex-start", gap: 10,
      padding: 10, background: "#fff", border: "1px solid #e2e8f0", borderRadius: 6,
    }}>
      <span style={{
        width: 10, height: 10, borderRadius: 5, background: dot,
        marginTop: 6, flexShrink: 0,
        boxShadow: state === "active" ? "0 0 0 3px rgba(16,185,129,0.18)" : "none",
      }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8, justifyContent: "space-between" }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {output.name}
          </div>
          <div style={{ fontSize: 10, fontWeight: 700, color: dot, flexShrink: 0 }}>
            {stateLabel}
          </div>
        </div>
        <div style={{ fontSize: 11, color: "#64748b" }}>{output.type}</div>
        {output.recorders.length === 0 && (
          <div style={{ fontSize: 11, color: "#a16207", marginTop: 4 }}>
            No recorder attached — add a NumpyArrayNodeRecorder for this node to
            capture its flow.
          </div>
        )}
        {output.recorders.length > 0 && (
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 8 }}>
            {output.recorders.map((r) => (
              <div key={r.recorderName}>
                <div style={{
                  fontSize: 11, color: "#334155",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}>
                  <span style={{ color: "#64748b" }}>{r.recorderName}</span>
                  {" = "}
                  <span style={{ fontWeight: 600, color: r.aggValue === null ? "#94a3b8" : "#0f172a" }}>
                    {r.aggValue === null ? "—" : formatFlow(r.aggValue)}
                  </span>
                </div>
                {/* Per-recorder stats strip (T1.2). Only renders when the
                    recorder has a CSV — aggregate-only recorders skip it. */}
                <RecorderStatsStrip
                  csvPath={r.csvPath}
                  recorderName={r.recorderName}
                  recorderType={r.type}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function formatFlow(v: number): string {
  if (Math.abs(v) >= 1e6 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) {
    return v.toExponential(3);
  }
  return v.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function statusBox(bg: string, fg: string): React.CSSProperties {
  return {
    padding: 10,
    background: bg,
    border: `1px solid ${fg}33`,
    borderRadius: 6,
    color: fg,
    fontSize: 12,
    marginBottom: 12,
  };
}

const emptyStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  color: "#64748b",
  fontSize: 13,
  padding: 24,
  textAlign: "center",
};

// Exported for unit tests — keeps the BFS + recorder-mapping logic in one place
// and makes the contract explicit. The component owns presentation; these are
// the data transforms it depends on.
export const _internal = { reachableFrom, readRecorders, ACTIVE_EPS };

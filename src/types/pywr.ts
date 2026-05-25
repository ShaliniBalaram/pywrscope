// src/types/pywr.ts
// TypeScript interfaces for Pywr model types
// All types derived from PYWR_SCHEMA.md

// A field value that can be either a numeric literal or a parameter reference string
export type FlowValue = number | string;

// Optional `position` object on any node. Three coordinate spaces are recognised
// across the Pywr ecosystem:
//   - schematic        : Pywr core / Pywr Viewer (abstract coordinates)
//   - editor_position  : pywr-editor (pixel coordinates)
//   - geographic       : real-world lon/lat (rarely useful for canvas layout)
// Embedding this object into the model JSON on export keeps a single file
// portable across all Pywr applications.
export interface PywrPosition {
  schematic?: [number, number];
  editor_position?: [number, number];
  geographic?: [number, number];
}

// ---------- Node interfaces ----------

export interface InputNode {
  name: string;
  type: "Input";
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface OutputNode {
  name: string;
  type: "Output";
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface LinkNode {
  name: string;
  type: "Link";
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface StorageNode {
  name: string;
  type: "Storage";
  max_volume: FlowValue;
  initial_volume?: number;
  initial_volume_pc?: number;
  min_volume?: FlowValue;
  cost?: FlowValue;
  level?: FlowValue;
  area?: FlowValue;
  num_inputs?: number;
  num_outputs?: number;
  comment?: string;
}

export interface VirtualStorageNode {
  name: string;
  type: "VirtualStorage";
  nodes: string[];
  min_volume?: number;
  max_volume?: number;
  initial_volume?: number;
  initial_volume_pc?: number;
  cost?: FlowValue;
  factors?: number[];
  comment?: string;
}

export interface AnnualVirtualStorageNode {
  name: string;
  type: "AnnualVirtualStorage";
  nodes: string[];
  max_volume: number;
  min_volume?: number;
  initial_volume?: number;
  initial_volume_pc?: number;
  cost?: FlowValue;
  factors?: number[];
  reset_day?: number;
  reset_month?: number;
  reset_to_initial_volume?: boolean;
  comment?: string;
}

export interface PiecewiseLinkNode {
  name: string;
  type: "PiecewiseLink";
  nsteps: number;
  costs?: number[];
  max_flows?: FlowValue[];
  comment?: string;
}

export interface AggregatedNode {
  name: string;
  type: "AggregatedNode";
  nodes: string[];
  min_flow?: FlowValue;
  max_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface AggregatedStorageNode {
  name: string;
  type: "AggregatedStorage";
  storages: string[];
  comment?: string;
}

export interface RiverNode {
  name: string;
  type: "River";
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface RiverGaugeNode {
  name: string;
  type: "RiverGauge";
  mrf?: FlowValue;
  cost?: number;
  mrf_cost?: number;
  comment?: string;
}

export interface CatchmentNode {
  name: string;
  type: "Catchment";
  flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface RiverSplitWithGaugeNode {
  name: string;
  type: "RiverSplitWithGauge";
  mrf?: number;
  cost?: number;
  mrf_cost?: number;
  factors?: number[];
  slot_names?: string[];
  comment?: string;
}

export interface LossLinkNode {
  name: string;
  type: "LossLink";
  loss_factor?: FlowValue;
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface DelayNode {
  name: string;
  type: "DelayNode";
  days?: number;
  initial_flow?: FlowValue;
  comment?: string;
}

export interface BreakLinkNode {
  name: string;
  type: "BreakLink";
  max_flow?: FlowValue;
  min_flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface MultiSplitLinkNode {
  name: string;
  type: "MultiSplitLink";
  nsteps?: number;
  extra_slots?: number;
  costs?: number[];
  max_flows?: FlowValue[];
  comment?: string;
}

export interface SeasonalVirtualStorageNode {
  name: string;
  type: "SeasonalVirtualStorage";
  nodes: string[];
  max_volume?: number;
  min_volume?: number;
  initial_volume?: number;
  initial_volume_pc?: number;
  cost?: FlowValue;
  factors?: number[];
  reset_day?: number;
  reset_month?: number;
  end_day?: number;
  end_month?: number;
  comment?: string;
}

export interface MonthlyVirtualStorageNode {
  name: string;
  type: "MonthlyVirtualStorage";
  nodes: string[];
  max_volume?: number;
  min_volume?: number;
  initial_volume?: number;
  initial_volume_pc?: number;
  cost?: FlowValue;
  factors?: number[];
  months?: number;
  comment?: string;
}

export interface RollingVirtualStorageNode {
  name: string;
  type: "RollingVirtualStorage";
  nodes: string[];
  max_volume?: number;
  min_volume?: number;
  initial_volume?: number;
  initial_volume_pc?: number;
  cost?: FlowValue;
  factors?: number[];
  days?: number;
  comment?: string;
}

export interface DischargeNode {
  name: string;
  type: "Discharge";
  flow?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface ReservoirNode {
  name: string;
  type: "Reservoir";
  max_volume?: FlowValue;
  initial_volume?: number;
  initial_volume_pc?: number;
  min_volume?: FlowValue;
  cost?: FlowValue;
  comment?: string;
}

export interface RiverSplitNode {
  name: string;
  type: "RiverSplit";
  factors?: number[];
  slot_names?: string[];
  cost?: FlowValue;
  comment?: string;
}

export interface KeatingAquiferNode {
  name: string;
  type: "KeatingAquifer";
  num_streams?: number;
  num_additional_inputs?: number;
  comment?: string;
}

// Union of all node types
export type PywrNode =
  | InputNode
  | OutputNode
  | LinkNode
  | StorageNode
  | VirtualStorageNode
  | AnnualVirtualStorageNode
  | PiecewiseLinkNode
  | AggregatedNode
  | AggregatedStorageNode
  | RiverNode
  | RiverGaugeNode
  | CatchmentNode
  | RiverSplitWithGaugeNode
  | LossLinkNode
  | DelayNode
  | BreakLinkNode
  | MultiSplitLinkNode
  | SeasonalVirtualStorageNode
  | MonthlyVirtualStorageNode
  | RollingVirtualStorageNode
  | DischargeNode
  | ReservoirNode
  | RiverSplitNode
  | KeatingAquiferNode;

// ---------- Edge type ----------
//
// Pywr's canonical edge shape is an array, NOT an object:
//   ["from", "to"]                              — simple connection
//   ["from", "to", from_slot, to_slot]          — with explicit slots
//
// Slots are positional and may be ints (slot indices) or strings (slot names),
// per the Pywr schema. Earlier versions of PyWR Canvas stored edges as
// {from_node, to_node} objects in memory, which broke round-tripping with
// Pywr core (Pywr.model.Model.load expects arrays). The Rust parser still
// accepts the object form on import for backwards compatibility, but the
// in-memory and on-disk representation is now the canonical array.
export type PywrEdgeSlot = number | string;
export type PywrEdge =
  | readonly [string, string]
  | readonly [string, string, PywrEdgeSlot, PywrEdgeSlot];

// ---------- Timestepper ----------

export interface PywrTimestepper {
  start: string;
  end: string;
  timestep: number;
}

// ---------- Metadata ----------

export interface PywrMetadata {
  title?: string;
  description?: string;
  minimum_version?: string;
}

// ---------- Recorder interfaces ----------
//
// Recorders are stored on disk as a {name → recorder-object} map. The KEY is
// the recorder's name (used in the run output's per-recorder CSV filename);
// the VALUE never carries a `name` field. We model that here as
// PywrModel.recorders: Record<string, PywrRecorder>.
//
// The union below is a discriminated union on the `type` tag. Five concrete
// variants cover the recorders our UI consumes (flow, deficit, storage,
// normalised-storage, parameter); UnknownRecorder is the open-world fallback
// for the dozens of other Pywr recorder classes. With UnknownRecorder in the
// union, a JSON containing a custom recorder type still type-checks — it just
// doesn't get the typed `node`/`param` narrowing.
//
// Consumers MUST use isNodeBoundRecorder / isParameterBoundRecorder to narrow
// before reading the binding field. Those guards do the runtime check that
// each previous consumer was open-coding (typeof r.node === "string"), so the
// "is this field there?" class of runtime bugs collapses to one helper.

interface PywrRecorderCommon {
  temporal_agg_func?: string;
  is_objective?: string;
  ignore_nan?: boolean;
  comment?: string;
}

export interface NumpyArrayNodeRecorder extends PywrRecorderCommon {
  type: "NumpyArrayNodeRecorder";
  node: string;
  factor?: number;
}

export interface NumpyArrayNodeDeficitRecorder extends PywrRecorderCommon {
  type: "NumpyArrayNodeDeficitRecorder";
  node: string;
}

export interface NumpyArrayStorageRecorder extends PywrRecorderCommon {
  type: "NumpyArrayStorageRecorder";
  node: string;
  proportional?: boolean;
}

export interface NumpyArrayNormalisedStorageRecorder extends PywrRecorderCommon {
  type: "NumpyArrayNormalisedStorageRecorder";
  node: string;
}

export interface NumpyArrayParameterRecorder extends PywrRecorderCommon {
  type: "NumpyArrayParameterRecorder";
  param: string;
}

// Open-world fallback. `type` is the generic string so any Pywr recorder class
// we don't model explicitly still fits the union. Discrimination on the
// concrete-type literals still narrows away the variants above; UnknownRecorder
// remains as the residual case (and `node` / `param` are optional unknowns).
export interface UnknownRecorder {
  type: string;
  node?: unknown;
  param?: unknown;
  [key: string]: unknown;
}

export type PywrRecorder =
  | NumpyArrayNodeRecorder
  | NumpyArrayNodeDeficitRecorder
  | NumpyArrayStorageRecorder
  | NumpyArrayNormalisedStorageRecorder
  | NumpyArrayParameterRecorder
  | UnknownRecorder;

// Any recorder that binds to a graph node by name. We deliberately DON'T
// hardcode a known-types list here: Pywr ships dozens of recorder classes
// (MeanFlowNodeRecorder, TotalDeficitNodeRecorder, ...), and downstream
// users author custom recorders all the time. Anything with a `node: string`
// field is treated as node-bound — that's the contract cascade-delete,
// results, mass-balance, reliability, and zero-flow all actually need.
//
// The narrowed type intersects every variant of PywrRecorder with
// `{ node: string }`. For NumpyArrayNodeRecorder / NumpyArrayNodeDeficit-
// Recorder / NumpyArrayStorageRecorder / NumpyArrayNormalisedStorageRecorder
// that's a no-op (they already declare `node: string`). For
// NumpyArrayParameterRecorder it becomes `never` (no `node` field). For
// UnknownRecorder it pins `node` to string. So a consumer that has narrowed
// via this guard can read `.node` directly — the entire "is this field
// there?" cast-and-check pattern collapses to a single isNodeBoundRecorder
// call.
export type NodeBoundRecorder = Extract<PywrRecorder, { node: string }> | (UnknownRecorder & { node: string });

export function isNodeBoundRecorder(r: unknown): r is NodeBoundRecorder {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  return typeof obj.type === "string" && typeof obj.node === "string";
}

// Symmetric guard for parameter-bound recorders. Same shape: any object with
// a string `param` field, regardless of `type`. Currently only consumed by
// future param-aware UIs; included so consumers have a single import surface
// for both binding flavours.
export type ParameterBoundRecorder = Extract<PywrRecorder, { param: string }> | (UnknownRecorder & { param: string });

export function isParameterBoundRecorder(r: unknown): r is ParameterBoundRecorder {
  if (!r || typeof r !== "object") return false;
  const obj = r as Record<string, unknown>;
  return typeof obj.type === "string" && typeof obj.param === "string";
}

// ---------- Top-level model ----------

export interface PywrModel {
  nodes: PywrNode[];
  edges: PywrEdge[];
  parameters: Record<string, unknown>;
  // Discriminated union — see PywrRecorder above. Consumers narrow via
  // isNodeBoundRecorder / isParameterBoundRecorder before reading `node` /
  // `param`. Anything that's not a recognised recorder shape falls through to
  // UnknownRecorder so the model still type-checks end-to-end.
  recorders: Record<string, PywrRecorder>;
  timestepper: PywrTimestepper;
  metadata?: PywrMetadata;
  // Pywr models may carry additional top-level data that the canvas does not
  // edit directly but must preserve exactly: tables, includes, scenarios,
  // pywr_editor metadata, and project-specific extension keys.
  [key: string]: unknown;
}

// ---------- Run-time event protocol ----------
//
// Mirrors the JSON-line schema in src-tauri/python/run_pywr.py. Every event
// the Tauri backend emits on `pywr://run/<id>` matches this union exactly.
// Adding a new variant here MUST be paired with a producer in run_pywr.py;
// otherwise the typed `code` discriminator on errors silently drifts.

export type PywrRunErrorCode =
  | "PYWR_IMPORT_FAILED"
  | "MODEL_LOAD_FAILED"
  | "SOLVER_ERROR"
  | "RUN_FAILED"
  | "PYTHON_MISSING"
  | "RUNTIME_NOT_FOUND";

export interface PywrRunStartedEvent {
  type: "started";
  model: string;
  timesteps_total: number;
}

export interface PywrRunProgressEvent {
  type: "progress";
  step: number;
  total: number;
  pct: number;
  date: string;
}

export interface PywrRunDoneEvent {
  type: "done";
  outputs: { name: string; path: string }[];
  stats: { timesteps: number; scenarios: number; seconds: number };
}

export interface PywrRunErrorEvent {
  type: "error";
  code: PywrRunErrorCode;
  message: string;
  traceback: string;
}

export interface PywrRunCancelledEvent {
  type: "cancelled";
}

export interface PywrRunLogEvent {
  type: "log";
  level: "info" | "warn" | "error";
  message: string;
}

export type PywrRunEvent =
  | PywrRunStartedEvent
  | PywrRunProgressEvent
  | PywrRunDoneEvent
  | PywrRunErrorEvent
  | PywrRunCancelledEvent
  | PywrRunLogEvent;

export interface PywrRunHandle {
  runId: string;
  eventName: string;
}

export type CheckPythonResult =
  | { ok: "ok"; python_version: string; pywr_version: string }
  | { ok: "err"; code: string; message: string };

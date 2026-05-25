# PYWR_SCHEMA.md — Pywr node type schemas

## Source

All schemas derived from pywr Python package source code.
- Node types: `pywr/nodes.py` and `pywr/domains/river.py`
- Recorder types: `pywr/recorders/recorders.py`
- JSON format: https://pywr.github.io/pywr/json.html
- Version: pywr >= 1.3 (pin exact version in requirements.txt when installing)

Do not add fields that are not in the pywr source.

---

## Node types

All nodes require `name` (string) and `type` (string, case-insensitive in pywr JSON).
All flow/volume/cost fields accept either a numeric literal or a parameter reference string.

---

### Input

Source: `pywr.nodes.Input` (inherits Node, BaseInput)

Required fields: `name`, `type`

Optional fields:
- `max_flow` — float or parameter name — maximum flow constraint (default: no limit)
- `min_flow` — float or parameter name — minimum flow constraint (default: 0.0)
- `cost` — float or parameter name — cost per unit flow (default: 0.0)

JSON example:
```json
{ "name": "Oakhanger_GW", "type": "Input", "max_flow": 5.0, "cost": -10 }
```

---

### Output

Source: `pywr.nodes.Output` (inherits Node, BaseOutput)

Required fields: `name`, `type`

Optional fields:
- `max_flow` — float or parameter name — maximum flow accepted (default: no limit)
- `min_flow` — float or parameter name — minimum flow constraint (default: 0.0)
- `cost` — float or parameter name — cost per unit flow (default: 0.0)

JSON example:
```json
{ "name": "Demand_Zone_A", "type": "Output", "max_flow": 12.5, "cost": -500 }
```

---

### Link

Source: `pywr.nodes.Link` (inherits Node, BaseLink)

Required fields: `name`, `type`

Optional fields:
- `max_flow` — float or parameter name — maximum flow through link (default: no limit)
- `min_flow` — float or parameter name — minimum flow constraint (default: 0.0)
- `cost` — float or parameter name — cost per unit flow (default: 0.0)

JSON example:
```json
{ "name": "Transfer_Pipe", "type": "Link", "max_flow": 50.0, "cost": 1.5 }
```

---

### Storage

Source: `pywr.nodes.Storage`

Required fields: `name`, `type`, `max_volume`
Must provide exactly one of: `initial_volume` or `initial_volume_pc`

Optional fields:
- `min_volume` — float or parameter name — minimum storage volume (default: 0.0)
- `initial_volume` — float — absolute initial storage volume
- `initial_volume_pc` — float [0.0–1.0] — initial volume as proportion of max_volume
- `cost` — float or parameter name — cost (default: 0.0)
- `level` — float or parameter name — water level (default: None)
- `area` — float or parameter name — surface area (default: None)
- `num_inputs` — int — number of input sub-nodes (default: 1)
- `num_outputs` — int — number of output sub-nodes (default: 1)

JSON example:
```json
{
  "name": "Big_Wet_Lake",
  "type": "Storage",
  "max_volume": 1000,
  "initial_volume": 700,
  "min_volume": 0,
  "cost": -10.0
}
```

---

### VirtualStorage

Source: `pywr.nodes.VirtualStorage`

Required fields: `name`, `type`, `nodes`

Optional fields:
- `nodes` — array of node name strings — the real nodes whose flows are tracked (required)
- `min_volume` — float — minimum virtual volume (default: 0.0)
- `max_volume` — float — maximum virtual volume (default: 0.0)
- `initial_volume` — float — absolute initial volume
- `initial_volume_pc` — float [0.0–1.0] — initial volume as proportion of max_volume
- `cost` — float or parameter name — cost (default: 0.0)
- `factors` — array of floats — per-node scaling factors (default: 1.0 each, length matches nodes)

JSON example:
```json
{
  "name": "Annual_Licence_VS",
  "type": "VirtualStorage",
  "nodes": ["Abstraction_1", "Abstraction_2"],
  "max_volume": 5000,
  "initial_volume": 5000,
  "factors": [1.0, 1.0]
}
```

---

### AnnualVirtualStorage

Source: `pywr.nodes.AnnualVirtualStorage` (extends VirtualStorage)

Required fields: `name`, `type`, `nodes`, `max_volume`

Optional fields: all VirtualStorage optional fields, plus:
- `reset_day` — int [1–31] — day of month to reset (default: 1)
- `reset_month` — int [1–12] — month to reset (default: 1)
- `reset_to_initial_volume` — bool — whether to reset to initial_volume instead of max_volume (default: false)

JSON example:
```json
{
  "name": "Annual_GW_Licence",
  "type": "AnnualVirtualStorage",
  "nodes": ["GW_Abstraction"],
  "max_volume": 1000,
  "initial_volume": 1000,
  "reset_day": 1,
  "reset_month": 4,
  "reset_to_initial_volume": false
}
```

---

### PiecewiseLink

Source: `pywr.nodes.PiecewiseLink` (extends Node)

Required fields: `name`, `type`, `nsteps`

Optional fields:
- `nsteps` — int — number of piecewise steps (required, positional in Python)
- `costs` — array of floats — cost per step (length must equal nsteps)
- `max_flows` — array of floats or parameter names — max flow per step (length must equal nsteps)

JSON example:
```json
{
  "name": "River_Reach",
  "type": "PiecewiseLink",
  "nsteps": 2,
  "costs": [0.0, -100.0],
  "max_flows": [10.0, 100.0]
}
```

---

### AggregatedNode

Source: `pywr.nodes.AggregatedNode` (extends Node)

Required fields: `name`, `type`, `nodes`

Optional fields:
- `nodes` — array of node name strings — the nodes to aggregate (required)
- `min_flow` — float or parameter name — aggregate minimum flow constraint
- `max_flow` — float or parameter name — aggregate maximum flow constraint
- `cost` — float or parameter name — aggregate cost

JSON example:
```json
{
  "name": "Aggregated_Demand",
  "type": "AggregatedNode",
  "nodes": ["Demand_A", "Demand_B"],
  "max_flow": 50.0
}
```

---

### AggregatedStorage

Source: `pywr.nodes.AggregatedStorage`

Required fields: `name`, `type`, `storages`

Optional fields:
- `storages` — array of storage node name strings — the storages to aggregate (required)

JSON example:
```json
{
  "name": "Total_Reservoir_Group",
  "type": "AggregatedStorage",
  "storages": ["Reservoir_A", "Reservoir_B"]
}
```

---

### River

Source: `pywr.domains.river.River` (inherits RiverDomainMixin, Link)

Required fields: `name`, `type`

Optional fields: same as Link
- `max_flow` — float or parameter name (default: no limit)
- `min_flow` — float or parameter name (default: 0.0)
- `cost` — float or parameter name (default: 0.0)

JSON example:
```json
{ "name": "Thames_Reach_1", "type": "River" }
```

---

### RiverGauge

Source: `pywr.domains.river.RiverGauge` (inherits RiverDomainMixin, PiecewiseLink)

Required fields: `name`, `type`

Optional fields:
- `mrf` — float or parameter name — minimum residual flow constraint (default: 0.0)
- `cost` — float — cost for flow above MRF (default: 0.0)
- `mrf_cost` — float — cost applied to flow below MRF (default: 0.0)

JSON example:
```json
{
  "name": "Teddington_GS",
  "type": "RiverGauge",
  "mrf": 200.0,
  "cost": 0.0,
  "mrf_cost": -1000.0
}
```

---

### Catchment

Source: `pywr.domains.river.Catchment` (inherits RiverDomainMixin, Input)

Required fields: `name`, `type`

Optional fields:
- `flow` — float or parameter name — catchment inflow (default: 0.0)
- `cost` — float or parameter name — cost per unit flow (default: 0.0)

JSON example:
```json
{ "name": "Kennet_Catchment", "type": "Catchment", "flow": "kennet_flow_param" }
```

---

### RiverSplitWithGauge

Source: `pywr.domains.river.RiverSplitWithGauge` (inherits RiverSplit)

Required fields: `name`, `type`

Optional fields:
- `mrf` — float — minimum residual flow (default: 0.0)
- `cost` — float — cost (default: 0.0)
- `mrf_cost` — float — cost applied when flow is below MRF (default: 0.0)
- `factors` — array of floats — split proportions (SCHEMA_GAP: see Unconfirmed below)
- `slot_names` — array of strings — output slot names (SCHEMA_GAP: see Unconfirmed below)

JSON example:
```json
{
  "name": "Confluence_Split",
  "type": "RiverSplitWithGauge",
  "mrf": 50.0,
  "mrf_cost": -2000.0
}
```

---

## Recorder types

Recorders are defined in the `recorders` dict of the model JSON.
All recorders require `name` and `type`.
All recorders accept `is_objective`, `comment`, `ignore_nan`, `temporal_agg_func`.

---

### NumpyArrayNodeRecorder

Source: `pywr.recorders.NumpyArrayNodeRecorder`

Records a timeseries of flow through a node for each scenario.

Required fields: `name`, `type`, `node`
Optional fields:
- `node` — string — name of the node to record (required)
- `temporal_agg_func` — string — aggregation function over time (default: "mean")
- `factor` — float — scaling factor applied to recorded values (default: 1.0)

JSON example:
```json
{
  "name": "rec_Abstraction_1",
  "type": "NumpyArrayNodeRecorder",
  "node": "Abstraction_1"
}
```

---

### NumpyArrayNodeDeficitRecorder

Source: `pywr.recorders.NumpyArrayNodeDeficitRecorder`

Records a timeseries of deficit (max_flow - actual_flow) for a node.

Required fields: `name`, `type`, `node`
Optional fields:
- `node` — string — name of the node to record (required)
- `temporal_agg_func` — string — aggregation function over time (default: "mean")

JSON example:
```json
{
  "name": "rec_Demand_A_deficit",
  "type": "NumpyArrayNodeDeficitRecorder",
  "node": "Demand_A"
}
```

---

### NumpyArrayStorageRecorder

Source: `pywr.recorders.NumpyArrayStorageRecorder`

Records a timeseries of storage volume for a Storage node.

Required fields: `name`, `type`, `node`
Optional fields:
- `node` — string — name of the storage node to record (required)
- `proportional` — bool — record as proportion [0–1] of max_volume instead of absolute volume (default: false)
- `temporal_agg_func` — string — aggregation function over time (default: "mean")

JSON example:
```json
{
  "name": "rec_Reservoir_volume",
  "type": "NumpyArrayStorageRecorder",
  "node": "Big_Wet_Lake"
}
```

---

### NumpyArrayNormalisedStorageRecorder

Source: `pywr.recorders.NumpyArrayNormalisedStorageRecorder`

Records storage volume normalised by max_volume.

Required fields: `name`, `type`, `node`
Optional fields:
- `node` — string — name of the storage node (required)
- `temporal_agg_func` — string (default: "mean")

JSON example:
```json
{
  "name": "rec_Reservoir_pc",
  "type": "NumpyArrayNormalisedStorageRecorder",
  "node": "Big_Wet_Lake"
}
```

---

### NumpyArrayParameterRecorder

Source: `pywr.recorders.NumpyArrayParameterRecorder`

Records a timeseries of a parameter's value each timestep.

Required fields: `name`, `type`, `param`
Optional fields:
- `param` — string — name of the parameter to record (required)
- `temporal_agg_func` — string — aggregation function over time (default: "mean")

JSON example:
```json
{
  "name": "rec_mrf_profile",
  "type": "NumpyArrayParameterRecorder",
  "param": "mrf_profile"
}
```

---

## Unconfirmed fields

These fields appear in real model files but could not be fully verified against
pywr source code. Mark any code that uses them with a `// SCHEMA_GAP` comment.

| Node type            | Field name   | Observed values          | Status                                      |
|----------------------|--------------|--------------------------|---------------------------------------------|
| RiverSplitWithGauge  | `factors`    | array of floats          | Likely inherited from RiverSplit, unverified |
| RiverSplitWithGauge  | `slot_names` | array of strings         | Likely inherited from RiverSplit, unverified |
| All nodes            | `comment`    | string                   | Accepted by Loadable mixin, safe to use      |

---

## Name discrepancy note

`NODE_TYPES.md` references `NumpyArrayDeficitNodeRecorder`.
The pywr API documentation names this class `NumpyArrayNodeDeficitRecorder`.
Use `NumpyArrayNodeDeficitRecorder` in all code. Update NODE_TYPES.md badge
section when confirmed against installed pywr version.

# Results & diagnostics roadmap

## Tier 1 — high value, low effort

- [x] **T1.1 — Per-node time series chart** *(extends ResultsTab)*
  Click a node → plot its flow series for the run. Use `readCsvPreview` against
  the recorder's CSV (path in `run.outputs`). Reference lines from `max_flow`,
  `min_flow`, `cost` already on the node. Replaces ~10 per-node dropdown plots.
  *Done: `NodeTimeSeriesChart.tsx` renders one inline-SVG chart per recorder
  bound to the selected node, with `max_flow` / `min_flow` / `cost` reference
  lines pulled from the node JSON and a hover crosshair tracking (date, value).
  Whole-series read via `readCsvPreview` capped at 200k rows. Wired into
  ResultsTab's Downstream view; pure helpers covered by
  `src/test/NodeTimeSeriesChart.test.ts`.*

- [x] **T1.2 — Per-node statistics table** *(extends ResultsTab DownstreamPanel)*
  For each downstream Output already enumerated, show mean, max, zero-day count,
  % time active, annual total. summary.json has aggregates; mean/max need one
  read of the per-node CSV. Mirrors notebook DIAG-3/4/5.
  *Done: pure helpers in `src/lib/recorderStats.ts` (24 unit tests). Strip
  component `RecorderStatsStrip.tsx` (5 component tests). Wired into
  `OutputRow` so each recorder shows mean · max · zero-days · % active ·
  annual total under its aggregate value.*

- [x] **T1.3 — Zero-flow analyzer** *(new tab or section)*
  Zero-flow days per node, sorted. Color: ≥30 red, ≥10 orange, else green.
  Catches orphan branches, infeasible licence caps, miswired costs. Generic
  across Output/Link/Storage.
  *Done: `severityForZeroDays` in recorderStats.ts (5 unit tests pin the
  spec thresholds). New `ZeroFlowAnalyzer.tsx` loads every node-recorder
  CSV in parallel, renders a sortable rank table with traffic-light dots,
  severity tally chips, and a name filter. Wired into ResultsTab via a
  two-button view toggle (Downstream / Zero-flow rank). Click-through on a
  row jumps back to the per-node view. 11 component tests; 257/257 suite
  green.*

- [x] **T1.4 — System mass balance audit** *(new diagnostic, like ValidationBar)*
  Sum-of-Inputs vs Sum-of-Outputs (annual + per-timestep). Flag negative
  imbalance = LP violation. Notebook DIAG-6 caught real bugs. Generic.
  *Done: `classifyNodeForBalance` + `computeMassBalance` pure helpers in
  `src/lib/massBalance.ts` (33 unit tests). Sources = Input/Catchment/
  Discharge; sinks = Output; storage = Storage/Reservoir; everything else
  internal (skipped). Per-step `net = inputs - outputs`, run-level
  `residual = inputs - outputs - ΔS`, with absolute floor (1e-6) + relative
  tolerance (1e-4) to suppress IEEE roundoff. New `MassBalanceAudit.tsx`
  loads every source/sink/storage recorder CSV in parallel, renders four
  summary cards (Σ in / Σ out / Δ storage / Residual), a severity pill
  (clean · imbalance · LP violation), and a worst-imbalance day table with
  click-through to the per-node view. Wired into ResultsTab as a third
  toggle alongside Downstream / Zero-flow. 9 component tests.*

## Tier 2 — high value, medium effort

- [x] **T2.5 — Annual network Sankey**
  Turn on `save_routes_flows=True` in `run_pywr.py`, read H5 for per-edge flow.
  Render with Plotly Sankey (vendored) or custom SVG.
  *Done: `run_pywr.py` flips `solver.save_routes_flows = True` before
  setup (best-effort; falls through silently when the solver doesn't
  expose it), then aggregates the captured route × timestep × scenario
  array down to per-edge totals via `_write_edge_flows` /
  `_reduce_routes_flows`. Output is `edge_flows.json` in the run's
  outDir (added to the `outputs` index alongside summary.json and the
  recorder CSVs). Pure layout in `src/lib/sankeyLayout.ts`
  (`computeSankeyLayout`, `formatSankeyFlow`; 14 unit tests): Kahn-style
  longest-path layering with cycle fallback, throughput-proportional
  node heights with auto-scaling to a `maxHeight` budget,
  flow-proportional ribbon stripes ordered by counterparty centre to
  reduce visible crossings, cubic-Bézier edge paths. New
  `SankeyView.tsx` loads the file, runs the layout, and renders inline
  SVG (no chart library). Graceful empty states: missing
  edge_flows.json (solver feature unavailable), parse error, zero
  usable edges. Wired into ResultsTab as the eighth toggle; node-label
  click jumps to Downstream. 5 component tests; 428/428 suite green.*

- [x] **T2.6 — Flow Duration Curves**
  For selected node: sort recorded flow descending vs exceedance %.
  Answers "how much of the time does this node carry more than X".
  *Done: pure `computeFlowDuration` + `flowAtExceedance` in
  `src/lib/flowDuration.ts` (15 unit tests pin Weibull plotting position,
  Gringorten/Cunnane variants, NaN handling, linear interpolation).
  New `FlowDurationCurve.tsx` renders one SVG curve per recorder below the
  time-series chart in the Downstream view, with Q10/Q50/Q90 reference
  lines and hover crosshair showing (exceedance %, flow). Reuses the
  recorder list already prepared for NodeTimeSeriesChart so the wiring
  is one prop. 5 component tests.*

- [x] **T2.7 — Deficit / reliability dashboard** *(extends Results tab)*
  For every Output with numeric `max_flow` (treat as demand): deficit days,
  % reliability, longest consecutive deficit run, total shortfall. Reliability
  league table worst→best. Replicates DIAG-5 + N-2 + N-3.
  *Done: pure `computeReliability` + `extractDemand` + `severityForReliability`
  in `src/lib/reliability.ts` (25 unit tests). Tolerance band 1% (configurable);
  severity thresholds: <80% critical, <95% warn, else ok. New
  `ReliabilityDashboard.tsx` sorts worst→best, with a separate section for
  parameter-driven `max_flow` references (skipped from ranking since they
  need parameter resolution — T3 territory). Filter input, click-through to
  per-node Downstream view, traffic-light dots, severity tally chips. Wired
  into ResultsTab as the fourth toggle. 10 component tests.*

## Tier 3 — useful, more invested

- [x] **T3.8 — EDO event log + severity matrix**
  Runs of ≥N consecutive deficit days (configurable). Table: DC, start, end,
  duration. Bar chart: count × mean × max duration per DC. Generic algorithm:
  "consecutive days where actual < demand × tolerance".
  *Done: `extractDeficitEvents` + `summariseEvents` in
  `src/lib/reliability.ts` (12 new unit tests). Min-duration default 7 days
  (configurable). New `DeficitEvents.tsx` renders sortable events table
  (duration descending) plus per-DC summary strip with horizontal bars sized
  by max duration. Changing the minimum-duration input recomputes events from
  cached parsed values without re-reading CSVs (verified by test). Wired
  into ResultsTab as the fifth toggle. 5 component tests.*

- [x] **T3.9 — Concurrent-failure timeseries**
  Count Output nodes in deficit per day. Line chart + heatmap (Output × date,
  red on deficit days). Shows drought clustering vs random failures.
  *Done: `computeDeficitIndicator` + `buildConcurrentFailureMatrix` in
  `src/lib/reliability.ts` (12 new unit tests). Indicator collapses
  multi-scenario via mean and emits Int8 sentinels (1=deficit, 0=met,
  -1=no-data) so a 100-year × 200-node matrix fits in ~8 MB. The builder
  picks the longest supplied timeline as the reference and drops misaligned
  rows (surfaced in the header). New `ConcurrentFailureChart.tsx` reuses
  `collectReliabilityCandidates` to enumerate numeric-demand Outputs, then
  renders (a) an inline-SVG line chart of per-step concurrent-deficit count
  with a peak reference line + hover crosshair, and (b) a canvas heatmap
  (Output × date) with auto column-binning for long horizons. Tooltip on
  hover names the node, date, and state; row labels click-through to the
  Downstream view. Wired into ResultsTab as the sixth toggle.
  5 component tests; 386/386 suite green.*

- [x] **T3.10 — Node-pair source attribution** *(extends edge highlighting)*
  For selected sink: fraction of delivered flow originating at each upstream
  source. Inverse of current BFS, weighted by recorded flows.
  *Done: `computeSourceAttribution` in `src/lib/sourceAttribution.ts`
  (14 unit tests). Algorithm: reverse-topological Kahn walk from the sink,
  distributing each node's accumulated claim across upstream parents
  proportionally to their recorded node flows. Source nodes (Input /
  Catchment / Discharge) terminate the walk; zero-flow parents are pruned;
  claim that can't reach a recorded source becomes "unresolved" (surfaced
  as a hatched bar segment + info callout). Self-attribution short-circuit
  for source-typed selections. Cycle detection flags unprocessed ancestors
  with non-zero claim. New `SourceAttribution.tsx` renders a stacked
  horizontal bar (one segment per source, palette aligned with the canvas)
  + sortable per-source table with share / contribution / source-flow
  columns. Wired into ResultsTab as the seventh toggle; clicking a source
  row jumps to its Downstream view. 6 component tests; 409/409 suite green.*

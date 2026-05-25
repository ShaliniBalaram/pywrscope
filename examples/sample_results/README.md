# Sample CSV files

Reference shapes for the formats the Results Viewer and CSV-linked parameters
accept. The viewer (`Map tab → Open results file…`) reads any CSV that follows
either layout below.

## `sample_results/recorder_example.csv` — Pywr run output

The shape `run_pywr.py` writes for every array recorder. The first column is an
ISO-8601 date; remaining columns are one per scenario.

```
date,scenario_0,scenario_1,scenario_2
2024-01-01,5.20,4.81,5.05
2024-01-02,5.15,4.79,5.02
```

Conventions:

- Header row required. The viewer keys off it for column labels.
- `date` column may also be capitalised (`Date`), or named after an index axis.
- Numeric cells only in scenario columns; blank cells render as empty strings.
- Encoding: UTF-8, comma separator, LF or CRLF line endings.

## `sample_input/inflows_example.csv` — CSV parameter input

The shape `CSVParameter` (and the `🔗 Link CSV` button in the Properties panel)
expects. Same as the recorder layout, but the value columns carry the names of
the series you want to reference from the model JSON.

```
Date,Catchment_A,Catchment_B,Reservoir_Inflow
2024-01-01,12.40,3.80,8.20
2024-01-02,11.95,3.72,8.05
```

When you link a node field, the picker reads the header row and shows the
column names. The resulting parameter looks like:

```json
{
  "type": "CSVParameter",
  "url": "/path/to/inflows_example.csv",
  "column": "Catchment_A",
  "index_col": "Date"
}
```

## HDF5 (`.h5` / `.hdf5`)

The viewer opens any HDF5 file readable by `h5py`. When the file contains
multiple datasets you pick one from the left sidebar; with a single dataset it
opens directly. Higher-dimensional datasets are flattened into a 2-D table for
preview. Pywr's tables-backed HDF5 outputs work without configuration.

// src-tauri/src/lib.rs — Pywrscope Tauri backend
// All model logic (parse, validate, export, add-recorders) runs here in Rust.
// File dialogs use tauri-plugin-dialog. File I/O uses std::fs directly.

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tokio::io::AsyncBufReadExt;
use tokio::sync::Mutex as AsyncMutex;

// ============================================================================
// VALIDATION — ported from python/pywr_schema.py and electron/pywr_schema.js
// ============================================================================

const VALID_NODE_TYPES: &[&str] = &[
    "input",
    "output",
    "link",
    "catchment",
    "discharge",
    "losslink",
    "breaklink",
    "delaynode",
    "piecewiselink",
    "multisplitlink",
    "storage",
    "reservoir",
    "virtualstorage",
    "annualvirtualstorage",
    "seasonalvirtualstorage",
    "monthlyvirtualstorage",
    "rollingvirtualstorage",
    "aggregatednode",
    "aggregatedstorage",
    "river",
    "rivergauge",
    "riversplit",
    "riversplitwithgauge",
    "keatingaquifer",
];

const VIRTUAL_TYPES: &[&str] = &[
    "aggregatednode",
    "aggregatedstorage",
    "virtualstorage",
    "annualvirtualstorage",
    "seasonalvirtualstorage",
    "monthlyvirtualstorage",
    "rollingvirtualstorage",
];

const SOURCE_TYPES: &[&str] = &["input", "catchment", "discharge"];

#[derive(Serialize, Clone, Debug)]
struct ValidationIssue {
    code: String,
    severity: String,
    message: String,
    node_name: String,
}

// Extract (from, to) endpoints from an edge regardless of representation.
// Pywr's canonical edge form is the array ["from", "to", ...slot_args].
// Pywrscope before v1.6.0 emitted objects {"from_node":"A","to_node":"B"}
// and validators / saved files in the wild may still use either shape — this
// helper accepts both so validation, recorder-injection, and parsing all keep
// working without forcing an external migration.
fn edge_from_to(edge: &Value) -> Option<(&str, &str)> {
    if let Some(obj) = edge.as_object() {
        let from = obj.get("from_node").and_then(|v| v.as_str())?;
        let to = obj.get("to_node").and_then(|v| v.as_str())?;
        return Some((from, to));
    }
    if let Some(arr) = edge.as_array() {
        if arr.len() >= 2 {
            let from = arr[0].as_str()?;
            let to = arr[1].as_str()?;
            return Some((from, to));
        }
    }
    None
}

fn type_key(t: &str) -> String {
    t.to_lowercase()
}

fn required_fields(node_type: &str) -> Vec<&'static str> {
    match type_key(node_type).as_str() {
        "piecewiselink" => vec!["nsteps"],
        "storage" => vec!["max_volume"],
        "virtualstorage" => vec!["nodes"],
        "annualvirtualstorage" => vec!["nodes", "max_volume"],
        "seasonalvirtualstorage" => vec!["nodes"],
        "monthlyvirtualstorage" => vec!["nodes"],
        "rollingvirtualstorage" => vec!["nodes"],
        "aggregatednode" => vec!["nodes"],
        "aggregatedstorage" => vec!["storages"],
        _ => vec![],
    }
}

fn issue(code: &str, severity: &str, message: String, node_name: &str) -> ValidationIssue {
    ValidationIssue {
        code: code.to_string(),
        severity: severity.to_string(),
        message,
        node_name: node_name.to_string(),
    }
}

fn validate_single_node(node: &Value) -> Vec<ValidationIssue> {
    let mut out = vec![];

    let name = node.get("name").and_then(|n| n.as_str()).unwrap_or("").trim().to_string();
    let name_ref: &str;
    let owned_unnamed;

    if name.is_empty() {
        out.push(issue("MISSING_REQUIRED_FIELD", "error",
            "Node is missing a valid 'name' field".into(), ""));
        owned_unnamed = "<unnamed>".to_string();
        name_ref = &owned_unnamed;
    } else {
        name_ref = &name;
    }

    let node_type = match node.get("type").and_then(|t| t.as_str()) {
        Some(t) if !t.trim().is_empty() => t.to_string(),
        _ => {
            out.push(issue("MISSING_REQUIRED_FIELD", "error",
                format!("Node '{}' is missing a valid 'type' field", name_ref), name_ref));
            return out;
        }
    };

    let tk = type_key(&node_type);
    if !VALID_NODE_TYPES.contains(&tk.as_str()) {
        out.push(issue("INVALID_NODE_TYPE", "error",
            format!("Node '{}' has unknown type '{}'", name_ref, node_type), name_ref));
        return out;
    }

    for field in required_fields(&node_type) {
        if node.get(field).is_none() {
            out.push(issue("MISSING_REQUIRED_FIELD", "error",
                format!("Node '{}' (type '{}') is missing required field '{}'", name_ref, node_type, field),
                name_ref));
        }
    }

    out
}

fn validate_model_inner(model: &Value) -> Vec<ValidationIssue> {
    let mut out: Vec<ValidationIssue> = vec![];

    let obj = match model.as_object() {
        Some(o) => o,
        None => {
            out.push(issue("MODEL_STRUCTURE_ERROR", "error",
                "Model must be a JSON object".into(), ""));
            return out;
        }
    };

    // nodes
    let empty_arr = vec![];
    let nodes: &Vec<Value> = match obj.get("nodes") {
        None => {
            out.push(issue("MODEL_STRUCTURE_ERROR", "error",
                "Model is missing 'nodes' array".into(), ""));
            return out;
        }
        Some(n) => match n.as_array() {
            Some(a) => a,
            None => {
                out.push(issue("MODEL_STRUCTURE_ERROR", "error",
                    "'nodes' must be an array".into(), ""));
                return out;
            }
        }
    };

    // edges
    let edges: &Vec<Value> = match obj.get("edges") {
        None => {
            out.push(issue("MODEL_STRUCTURE_ERROR", "warning",
                "Model has no 'edges' array".into(), ""));
            &empty_arr
        }
        Some(e) => match e.as_array() {
            Some(a) => a,
            None => {
                out.push(issue("MODEL_STRUCTURE_ERROR", "error",
                    "'edges' must be an array".into(), ""));
                &empty_arr
            }
        }
    };

    // timestepper
    match obj.get("timestepper") {
        None => out.push(issue("MODEL_STRUCTURE_ERROR", "error",
            "Model is missing 'timestepper'".into(), "")),
        Some(ts) => match ts.as_object() {
            None => out.push(issue("MODEL_STRUCTURE_ERROR", "error",
                "'timestepper' must be an object".into(), "")),
            Some(ts_obj) => {
                for f in &["start", "end", "timestep"] {
                    if !ts_obj.contains_key(*f) {
                        out.push(issue("MISSING_REQUIRED_FIELD", "error",
                            format!("'timestepper' is missing required field '{}'", f), ""));
                    }
                }
            }
        }
    }

    // validate each node; collect names
    let mut node_names: HashSet<String> = HashSet::new();
    let mut node_types: HashMap<String, String> = HashMap::new();

    for node in nodes {
        out.extend(validate_single_node(node));
        if let Some(name) = node.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
            if node_names.contains(name) {
                out.push(issue("DUPLICATE_NODE_NAME", "error",
                    format!("Duplicate node name '{}'", name), name));
            }
            node_names.insert(name.to_string());
            if let Some(t) = node.get("type").and_then(|t| t.as_str()) {
                node_types.insert(name.to_string(), t.to_string());
            }
        }
    }

    // validate edges (accepts both array and object shapes via edge_from_to)
    for (i, edge) in edges.iter().enumerate() {
        match edge_from_to(edge) {
            None => out.push(issue("ORPHANED_EDGE", "error",
                format!("Edge {} is malformed (expected [\"from\",\"to\"] or {{from_node,to_node}})", i), "")),
            Some((from, to)) => {
                if from.is_empty() || !node_names.contains(from) {
                    out.push(issue("ORPHANED_EDGE", "error",
                        format!("Edge {} references unknown from node '{}'", i, from), from));
                }
                if to.is_empty() || !node_names.contains(to) {
                    out.push(issue("ORPHANED_EDGE", "error",
                        format!("Edge {} references unknown to node '{}'", i, to), to));
                }
            }
        }
    }

    // connected nodes set
    let connected: HashSet<String> = edges.iter().flat_map(|e| {
        edge_from_to(e)
            .map(|(f, t)| vec![f.to_string(), t.to_string()])
            .unwrap_or_default()
    }).collect();

    // recorders index
    let mut recorder_nodes: HashSet<String> = HashSet::new();
    if let Some(recs) = obj.get("recorders") {
        let values: Vec<&Value> = if let Some(map) = recs.as_object() {
            map.values().collect()
        } else if let Some(arr) = recs.as_array() {
            arr.iter().collect()
        } else {
            vec![]
        };
        for rec in values {
            if let Some(r) = rec.get("node").or_else(|| rec.get("param"))
                .and_then(|v| v.as_str()) {
                recorder_nodes.insert(r.to_string());
            }
        }
    }

    // per-node warnings
    for node in nodes {
        let name = match node.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
            Some(n) => n,
            None => continue,
        };
        let tk = type_key(node.get("type").and_then(|t| t.as_str()).unwrap_or(""));
        let is_virtual = VIRTUAL_TYPES.contains(&tk.as_str());

        if !is_virtual && !connected.contains(name) {
            out.push(issue("UNCONNECTED_NODE", "warning",
                format!("Node '{}' is not connected to any edge", name), name));
        }
        // NO_RECORDER intentionally omitted — it fires for every node during
        // normal editing and is too noisy to be actionable.
    }

    // UNREACHABLE_DEMAND: BFS upstream from each Output
    let mut reverse_adj: HashMap<String, Vec<String>> = node_names.iter()
        .map(|n| (n.clone(), vec![])).collect();
    for edge in edges {
        if let Some((from, to)) = edge_from_to(edge) {
            if node_names.contains(from) && node_names.contains(to) {
                reverse_adj.entry(to.to_string()).or_default().push(from.to_string());
            }
        }
    }

    for node in nodes {
        let name = match node.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
            Some(n) => n,
            None => continue,
        };
        if type_key(node.get("type").and_then(|t| t.as_str()).unwrap_or("")) != "output" {
            continue;
        }
        let mut visited: HashSet<String> = HashSet::new();
        let mut queue = vec![name.to_string()];
        let mut found = false;
        while let Some(current) = queue.pop() {
            if visited.contains(&current) { continue; }
            visited.insert(current.clone());
            let tk = type_key(node_types.get(&current).map(|s| s.as_str()).unwrap_or(""));
            if SOURCE_TYPES.contains(&tk.as_str()) && current != name {
                found = true;
                break;
            }
            if let Some(ups) = reverse_adj.get(&current) {
                queue.extend(ups.iter().cloned());
            }
        }
        if !found {
            out.push(issue("UNREACHABLE_DEMAND", "warning",
                format!("Output node '{}' has no upstream path to any Input or Catchment", name),
                name));
        }
    }

    out
}

// ============================================================================
// RECORDER INJECTION — ported from python/add_recorders.py
// ============================================================================

const STORAGE_TYPES_REC: &[&str] = &["storage", "annualvirtualstorage"];
const FLOW_RECORDER_TYPES: &[&str] = &[
    "input", "output", "link", "river", "rivergauge", "catchment",
    "piecewiselink", "riversplithwithgauge",
];
const SKIP_TYPES_REC: &[&str] = &["aggregatednode", "aggregatedstorage", "virtualstorage"];

fn recorder_exists(rec_type: &str, node_name: &str, recs: &serde_json::Map<String, Value>) -> bool {
    recs.values().any(|v| {
        v.get("type").and_then(|t| t.as_str()) == Some(rec_type)
            && v.get("node").and_then(|n| n.as_str()) == Some(node_name)
    })
}

fn add_recorders_inner(model: Value) -> (Value, Vec<Value>) {
    let mut model = model;
    let mut added: Vec<Value> = vec![];

    let nodes: Vec<Value> = model.get("nodes")
        .and_then(|n| n.as_array()).cloned().unwrap_or_default();

    let mut recs: serde_json::Map<String, Value> = model.get("recorders")
        .and_then(|r| r.as_object()).cloned().unwrap_or_default();

    for node in &nodes {
        let name = match node.get("name").and_then(|n| n.as_str()).filter(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let node_type = match node.get("type").and_then(|t| t.as_str()).filter(|s| !s.is_empty()) {
            Some(t) => t.to_string(),
            None => continue,
        };
        let tk = type_key(&node_type);

        if SKIP_TYPES_REC.contains(&tk.as_str()) { continue; }

        if STORAGE_TYPES_REC.contains(&tk.as_str()) {
            const S_REC: &str = "NumpyArrayStorageRecorder";
            if !recorder_exists(S_REC, &name, &recs) {
                recs.insert(format!("{}_recorder", name),
                    json!({"type": S_REC, "node": name}));
                added.push(json!({"recorder_type": S_REC, "node": name}));
            }
            if tk == "annualvirtualstorage" {
                const N_REC: &str = "NumpyArrayNormalisedStorageRecorder";
                if !recorder_exists(N_REC, &name, &recs) {
                    recs.insert(format!("{}_normalised_recorder", name),
                        json!({"type": N_REC, "node": name}));
                    added.push(json!({"recorder_type": N_REC, "node": name}));
                }
            }
        } else if FLOW_RECORDER_TYPES.contains(&tk.as_str()) {
            const F_REC: &str = "NumpyArrayNodeRecorder";
            if !recorder_exists(F_REC, &name, &recs) {
                recs.insert(format!("{}_recorder", name),
                    json!({"type": F_REC, "node": name}));
                added.push(json!({"recorder_type": F_REC, "node": name}));
            }
            if tk == "output" && name.ends_with("_DC") {
                const D_REC: &str = "NumpyArrayNodeDeficitRecorder";
                if !recorder_exists(D_REC, &name, &recs) {
                    recs.insert(format!("{}_deficit_recorder", name),
                        json!({"type": D_REC, "node": name}));
                    added.push(json!({"recorder_type": D_REC, "node": name}));
                }
            }
        }
    }

    if let Some(obj) = model.as_object_mut() {
        obj.insert("recorders".to_string(), Value::Object(recs));
    }

    (model, added)
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

// Reject untrusted paths before any std::fs call. Two checks:
//   1. Absolute — relative paths resolve against the backend's cwd, which is
//      indeterminate from the renderer's perspective.
//   2. No `..` components — even on an absolute path, ".." segments let a
//      compromised renderer escape the intended directory (e.g.
//      "/Users/me/../../etc/passwd"). Reject before std::path canonicalisation
//      because canonicalisation only happens after we've already opened the file.
//
// Applied to every command that takes a user-supplied path so the renderer
// cannot trick the backend into reading or writing outside the user's chosen
// file. The dialog APIs always return absolute, traversal-free paths; this
// guard exists for the case where the renderer is compromised or a stale
// path is replayed from a sidecar / recent-files list.
fn validate_user_path(path: &str) -> Result<(), String> {
    let p = std::path::Path::new(path);
    if !p.is_absolute() {
        return Err("Path must be absolute".into());
    }
    for component in p.components() {
        if matches!(component, std::path::Component::ParentDir) {
            return Err("Path must not contain '..' segments".into());
        }
    }
    Ok(())
}

fn fp_to_string(fp: FilePath) -> Option<String> {
    match fp {
        FilePath::Path(p) => Some(p.to_string_lossy().to_string()),
        _ => None,
    }
}

// Use async commands + oneshot channel so the file dialog runs on the main
// thread via the callback while the command awaits on the async runtime.
// The blocking_* variants deadlock on macOS because both the dialog and the
// WebView compete for the main thread.

#[tauri::command]
async fn open_file_dialog(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Pywr JSON", &["json"])
        .pick_file(move |fp| { let _ = tx.send(fp); });
    rx.await.ok().flatten().and_then(fp_to_string)
}

#[tauri::command]
async fn open_image_dialog(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Images", &["png", "jpg", "jpeg"])
        .pick_file(move |fp| { let _ = tx.send(fp); });
    rx.await.ok().flatten().and_then(fp_to_string)
}

#[tauri::command]
async fn save_file_dialog(app: tauri::AppHandle, default_path: String) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .set_file_name(&default_path)
        .add_filter("Pywr JSON", &["json"])
        .save_file(move |fp| { let _ = tx.send(fp); });
    rx.await.ok().flatten().and_then(fp_to_string)
}

#[tauri::command]
async fn open_csv_dialog(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("CSV Files", &["csv"])
        .pick_file(move |fp| { let _ = tx.send(fp); });
    rx.await.ok().flatten().and_then(fp_to_string)
}

// Results-file picker — accepts both CSV and HDF5 outputs produced by Pywr.
// Same async-callback pattern as the other dialogs (the blocking variants
// deadlock on macOS).
#[tauri::command]
async fn open_results_dialog(app: tauri::AppHandle) -> Option<String> {
    let (tx, rx) = tokio::sync::oneshot::channel();
    app.dialog()
        .file()
        .add_filter("Pywr Results", &["csv", "h5", "hdf5"])
        .add_filter("CSV", &["csv"])
        .add_filter("HDF5", &["h5", "hdf5"])
        .pick_file(move |fp| { let _ = tx.send(fp); });
    rx.await.ok().flatten().and_then(fp_to_string)
}

#[tauri::command]
fn read_csv_columns(path: String) -> Vec<String> {
    if validate_user_path(&path).is_err() {
        return vec![];
    }
    std::fs::read_to_string(&path)
        .map(|content| {
            content.lines().next().unwrap_or("").split(',')
                .map(|col| col.trim().trim_matches('"').to_string())
                .filter(|s| !s.is_empty())
                .collect()
        })
        .unwrap_or_default()
}

// CSV preview — reads up to `max_rows` data rows from a CSV file and returns a
// {headers, rows, total_rows} JSON envelope. The whole file is scanned to
// report total_rows so the UI can show "N of M shown", but only the head is
// returned. This is plenty fast for typical Pywr output sizes (≤ 100k rows);
// if larger files become common we can move to a streaming parser.
//
// The parser is deliberately minimal: it splits on commas and strips one
// optional layer of surrounding double-quotes. Pywr's bundled CSV writer
// (pandas.DataFrame.to_csv) escapes embedded quotes by doubling them, but for
// a preview that fidelity isn't worth the extra dependency — anything that
// round-trips through this view should still be opened in a real CSV tool.
#[derive(Serialize)]
struct CsvPreview {
    ok: bool,
    headers: Vec<String>,
    rows: Vec<Vec<String>>,
    total_rows: usize,
    returned_rows: usize,
    error: Option<String>,
}

fn split_csv_line(line: &str) -> Vec<String> {
    line.split(',')
        .map(|c| c.trim().trim_matches('"').to_string())
        .collect()
}

#[tauri::command]
fn read_csv_preview(path: String, max_rows: usize) -> CsvPreview {
    if let Err(e) = validate_user_path(&path) {
        return CsvPreview {
            ok: false, headers: vec![], rows: vec![], total_rows: 0, returned_rows: 0,
            error: Some(e),
        };
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => return CsvPreview {
            ok: false, headers: vec![], rows: vec![], total_rows: 0, returned_rows: 0,
            error: Some(format!("Could not read file: {}", e)),
        },
    };
    let mut lines = content.lines();
    let header_line = match lines.next() {
        Some(l) => l,
        None => return CsvPreview {
            ok: false, headers: vec![], rows: vec![], total_rows: 0, returned_rows: 0,
            error: Some("File is empty".into()),
        },
    };
    let headers = split_csv_line(header_line);

    let mut rows: Vec<Vec<String>> = Vec::with_capacity(max_rows.min(1024));
    let mut total = 0usize;
    for line in lines {
        if line.is_empty() { continue; }
        total += 1;
        if rows.len() < max_rows {
            rows.push(split_csv_line(line));
        }
    }
    let returned_rows = rows.len();
    CsvPreview {
        ok: true,
        headers,
        rows,
        total_rows: total,
        returned_rows,
        error: None,
    }
}

// HDF5 preview — delegated to the bundled python because Rust HDF5 bindings
// require a dynamic libhdf5 we'd have to ship separately. The bundled runtime
// already includes h5py (via Pywr's deps), so we get HDF5 support for free.
//
// Mode "list" returns {datasets: [{name, shape, dtype, size}, ...]}.
// Mode "preview" returns {headers, rows, total_rows, returned_rows, shape}.
// On failure the helper writes {"ok": false, "error": "..."} so callers always
// get a parseable JSON line on stdout.
#[derive(serde::Deserialize, Serialize, Debug)]
pub struct H5Result {
    #[serde(default)]
    pub ok: bool,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(flatten)]
    pub data: Value,
}

async fn run_h5_helper(app: &tauri::AppHandle, args: Vec<String>) -> Result<Value, String> {
    let runtime_dir = python_runtime_dir(app)?;
    let py = python_binary(&runtime_dir);
    let script = runtime_dir.join("read_h5.py");
    if !py.is_file() {
        return Err(format!("Python interpreter not found at {}", py.display()));
    }
    if !script.is_file() {
        return Err(format!("HDF5 helper not found at {}", script.display()));
    }
    let output = tokio::process::Command::new(&py)
        .arg(&script)
        .args(&args)
        .output()
        .await
        .map_err(|e| format!("Failed to spawn python: {}", e))?;

    // Helper always emits a single-line JSON envelope on stdout — both for
    // success and failure. If parsing fails, surface stderr so the user has
    // something actionable instead of an opaque "unparseable" message.
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if stdout.is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        return Err(format!("HDF5 helper produced no output. stderr: {}", stderr));
    }
    // Helper may emit several lines (e.g. log lines from imports). Take the
    // last non-empty line as the result envelope — that's where emit_ok /
    // emit_err writes its single JSON object.
    let last = stdout.lines().rev().find(|l| !l.trim().is_empty()).unwrap_or("");
    serde_json::from_str::<Value>(last)
        .map_err(|e| format!("Unparseable helper output: {} — raw: {}", e, last))
}

#[tauri::command]
async fn read_h5_list(app: tauri::AppHandle, path: String) -> Value {
    match run_h5_helper(&app, vec![
        "--mode".into(), "list".into(),
        "--path".into(), path,
    ]).await {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
async fn read_h5_preview(app: tauri::AppHandle, path: String, dataset: String, max_rows: usize) -> Value {
    match run_h5_helper(&app, vec![
        "--mode".into(), "preview".into(),
        "--path".into(), path,
        "--dataset".into(), dataset,
        "--max-rows".into(), max_rows.to_string(),
    ]).await {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "error": e}),
    }
}

#[tauri::command]
fn parse_model(json_path: String) -> Value {
    if let Err(e) = validate_user_path(&json_path) {
        return json!({"ok": false, "error": e});
    }
    let path = std::path::Path::new(&json_path);
    if !path.exists() {
        return json!({"ok": false, "error": format!("File not found: {}", json_path)});
    }
    let raw = match std::fs::read_to_string(&json_path) {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": format!("Could not read file: {}", e)}),
    };
    let model: Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => return json!({"ok": false, "error": format!("Invalid JSON: {}", e)}),
    };
    if !model.is_object() {
        return json!({"ok": false, "error": "Model file must be a JSON object"});
    }
    let empty_obj = json!({});

    // Normalise edges to Pywr's canonical array form ["from", "to", ...slots].
    // Accept the legacy object form {"from_node","to_node"[, "from_slot", "to_slot"]}
    // for backwards compatibility with files saved by Pywrscope before v1.6.0.
    let raw_edges = model.get("edges").and_then(|e| e.as_array()).cloned().unwrap_or_default();
    let normalised_edges: Vec<Value> = raw_edges.into_iter().map(|edge| {
        // Already an array — keep as-is (preserves any slot args at indices 2+).
        if edge.is_array() {
            return edge;
        }
        // Object form → convert to array. Slots become positional.
        if let Some(obj) = edge.as_object() {
            if let (Some(from), Some(to)) = (
                obj.get("from_node").and_then(|v| v.as_str()),
                obj.get("to_node").and_then(|v| v.as_str()),
            ) {
                let from_slot = obj.get("from_slot").cloned();
                let to_slot = obj.get("to_slot").cloned();
                return match (from_slot, to_slot) {
                    (Some(fs), Some(ts)) => json!([from, to, fs, ts]),
                    _ => json!([from, to]),
                };
            }
        }
        edge
    }).collect();

    json!({
        "ok": true,
        "data": {
            "nodes":       model.get("nodes").filter(|v| v.is_array()).cloned().unwrap_or(json!([])),
            "edges":       Value::Array(normalised_edges),
            "parameters":  model.get("parameters").filter(|v| v.is_object()).cloned().unwrap_or(empty_obj.clone()),
            "recorders":   model.get("recorders").filter(|v| v.is_object()).cloned().unwrap_or(empty_obj.clone()),
            "timestepper": model.get("timestepper").cloned().unwrap_or(empty_obj.clone()),
            "metadata":    model.get("metadata").filter(|v| v.is_object()).cloned().unwrap_or(empty_obj),
        }
    })
}

#[tauri::command]
fn validate_model_cmd(model: Value) -> Value {
    if !model.is_object() {
        return json!({"ok": false, "error": "model must be a JSON object"});
    }
    let issues = validate_model_inner(&model);
    let warnings: Vec<&ValidationIssue> = issues.iter().filter(|i| i.severity == "warning").collect();
    let errors: Vec<&ValidationIssue> = issues.iter().filter(|i| i.severity == "error").collect();
    json!({"ok": true, "data": {"warnings": warnings, "errors": errors}})
}

#[tauri::command]
fn add_recorders_cmd(model: Value) -> Value {
    if !model.is_object() {
        return json!({"ok": false, "error": "model must be a JSON object"});
    }
    let (updated, added) = add_recorders_inner(model);
    json!({"ok": true, "data": {"model": updated, "added": added}})
}

#[tauri::command]
fn export_model(model: Value, output_path: String) -> Value {
    if !model.is_object() {
        return json!({"ok": false, "error": "model must be a JSON object"});
    }
    if let Err(e) = validate_user_path(&output_path) {
        return json!({"ok": false, "error": e});
    }
    // Always allow saving — validation issues are shown as warnings in the UI,
    // not as save blockers (matches pywr-editor behaviour).
    let json_str = match serde_json::to_string_pretty(&model) {
        Ok(s) => s,
        Err(e) => return json!({"ok": false, "error": format!("Could not serialise model: {}", e)}),
    };
    if let Err(e) = std::fs::write(&output_path, json_str) {
        return json!({"ok": false, "error": format!("Could not write file: {}", e)});
    }
    json!({"ok": true, "data": {"written_to": output_path}})
}

#[tauri::command]
fn save_layout_file(path: String, content: String) -> Result<(), String> {
    validate_user_path(&path)?;
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_layout_file(path: String) -> Option<String> {
    if validate_user_path(&path).is_err() {
        return None;
    }
    std::fs::read_to_string(&path).ok()
}

// ============================================================================
// PYWR MODEL RUNNER — spawns the bundled python interpreter against
// run_pywr.py and streams JSON-line events back to the frontend as Tauri events.
//
// Protocol contract is documented in src-tauri/python/run_pywr.py — this module
// is a transport layer and must not parse or interpret event payloads beyond
// forwarding them as opaque JSON. The frontend is the schema authority.
// ============================================================================

#[derive(Serialize, Clone, Debug)]
struct RunHandle {
    run_id: String,
    event_name: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(tag = "ok", rename_all = "snake_case")]
enum CheckPythonResult {
    Ok { python_version: String, pywr_version: String },
    Err { code: String, message: String },
}

// State singleton that owns running pywr child processes. Keyed by run_id so
// cancel_run can find the right child even if multiple runs are in flight.
// Uses tokio's async Mutex because Child::kill is async. Wrapped in Arc so
// the children map can be cloned into the stdout-reader spawn without
// fighting the State<'_, T> borrow lifetime.
type SharedChildren = Arc<AsyncMutex<HashMap<String, tokio::process::Child>>>;

#[derive(Default, Clone)]
struct RunState {
    children: SharedChildren,
}

static RUN_ID_SEQ: AtomicU64 = AtomicU64::new(0);

fn next_run_id() -> String {
    let n = RUN_ID_SEQ.fetch_add(1, Ordering::SeqCst);
    format!("run-{}", n)
}

// Resolve <resource_dir>/resources/python-runtime/. Tauri 2 preserves the
// `resources/` path prefix from tauri.conf.json's bundle.resources entry
// because that's where files live relative to the conf file.
fn python_runtime_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app.path().resource_dir()
        .map_err(|e| format!("resource_dir failed: {}", e))?;
    // Try bundled location first (release build); fall back to source-tree
    // location for `tauri dev` where resources are read from the workspace.
    let candidates = [
        base.join("resources").join("python-runtime"),
        base.join("python-runtime"),
        // Dev fallback — when running from src-tauri/target/debug, walk up.
        base.join("..").join("..").join("resources").join("python-runtime"),
    ];
    for c in &candidates {
        if c.is_dir() {
            return Ok(c.clone());
        }
    }
    Err(format!(
        "Bundled python-runtime not found. Run `npm run setup:python` to install it. \
         Searched: {:?}",
        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>()
    ))
}

fn python_binary(runtime_dir: &PathBuf) -> PathBuf {
    // python-build-standalone layout differs by OS. On Windows the interpreter
    // is at <root>/python.exe; on macOS/Linux at <root>/bin/python3.
    if cfg!(windows) {
        runtime_dir.join("python.exe")
    } else {
        runtime_dir.join("bin").join("python3")
    }
}

fn bridge_script(runtime_dir: &PathBuf) -> PathBuf {
    runtime_dir.join("run_pywr.py")
}

// Pure line-stream forwarder: read lines from `reader`, parse each as JSON,
// invoke `emit` with the parsed payload. Lines that fail to parse are wrapped
// as {"type":"log","level":"warn","message":"<raw line>"} so we don't lose
// signal but never corrupt the typed event channel.
//
// Extracted as a free function (instead of an inline closure) so unit tests
// can drive it with a Vec collector — no Tauri app handle required.
async fn forward_event_lines<R, F>(
    reader: R,
    mut emit: F,
)
where
    R: tokio::io::AsyncBufRead + Unpin,
    F: FnMut(Value),
{
    let mut lines = reader.lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let payload = match serde_json::from_str::<Value>(&line) {
            Ok(v) => v,
            Err(_) => json!({
                "type": "log",
                "level": "warn",
                "message": line,
            }),
        };
        emit(payload);
    }
}

#[tauri::command]
async fn run_model(
    app: tauri::AppHandle,
    state: tauri::State<'_, RunState>,
    json_path: String,
    out_dir: String,
) -> Result<RunHandle, String> {
    let runtime_dir = python_runtime_dir(&app)?;
    let py = python_binary(&runtime_dir);
    let script = bridge_script(&runtime_dir);

    if !py.is_file() {
        return Err(format!("Python interpreter not found at {}", py.display()));
    }
    if !script.is_file() {
        return Err(format!("Bridge script not found at {}", script.display()));
    }
    validate_user_path(&json_path)?;

    let run_id = next_run_id();
    let event_name = format!("pywr://run/{}", run_id);

    let mut child = tokio::process::Command::new(&py)
        .arg(&script)
        .arg("--model").arg(&json_path)
        .arg("--out").arg(&out_dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .map_err(|e| format!("Failed to spawn python: {}", e))?;

    let stdout = child.stdout.take()
        .ok_or_else(|| "Failed to capture python stdout".to_string())?;
    let stderr = child.stderr.take();

    let children = state.children.clone();
    children.lock().await.insert(run_id.clone(), child);

    // Stream stdout (JSON events) → app.emit. Each line is one event.
    let app_clone = app.clone();
    let event_name_clone = event_name.clone();
    let run_id_clone = run_id.clone();
    let children_for_task = children.clone();
    tokio::spawn(async move {
        let reader = tokio::io::BufReader::new(stdout);
        forward_event_lines(reader, |payload| {
            let _ = app_clone.emit(&event_name_clone, payload);
        }).await;

        // After stdout closes, reap the child and synthesize a final error
        // event if it exited non-zero without one already on the stream —
        // otherwise the UI would hang waiting for `done`.
        let mut map = children_for_task.lock().await;
        if let Some(mut child) = map.remove(&run_id_clone) {
            match child.wait().await {
                Ok(status) if !status.success() => {
                    let stderr_str = if let Some(mut e) = stderr {
                        use tokio::io::AsyncReadExt;
                        let mut buf = String::new();
                        let _ = e.read_to_string(&mut buf).await;
                        buf
                    } else {
                        String::new()
                    };
                    let _ = app_clone.emit(&event_name_clone, json!({
                        "type": "error",
                        "code": "RUN_FAILED",
                        "message": format!("Python exited with status {}", status),
                        "traceback": stderr_str,
                    }));
                }
                _ => {}
            }
        }
    });

    Ok(RunHandle { run_id, event_name })
}

#[tauri::command]
async fn cancel_run(
    state: tauri::State<'_, RunState>,
    run_id: String,
) -> Result<(), String> {
    // The reader task observes stdout EOF after the kill, drains stderr, and
    // removes the entry from the map. We deliberately don't remove here to
    // avoid a race where the reader still holds a borrow.
    let mut map = state.children.lock().await;
    match map.get_mut(&run_id) {
        Some(child) => child.kill().await.map_err(|e| e.to_string()),
        None => Err(format!("No active run with id {}", run_id)),
    }
}

#[tauri::command]
async fn check_python(app: tauri::AppHandle) -> CheckPythonResult {
    let runtime_dir = match python_runtime_dir(&app) {
        Ok(d) => d,
        Err(e) => return CheckPythonResult::Err {
            code: "RUNTIME_NOT_FOUND".into(),
            message: e,
        },
    };
    let py = python_binary(&runtime_dir);
    if !py.is_file() {
        return CheckPythonResult::Err {
            code: "PYTHON_BINARY_MISSING".into(),
            message: format!("No interpreter at {}", py.display()),
        };
    }

    // One-shot subprocess: print versions as a single JSON line so we never
    // have to parse free text. Mirrors the bridge script's protocol discipline.
    let script = "import sys, json, importlib; \
        try:\n    import pywr; v = pywr.__version__\n\
        except Exception as e:\n    print(json.dumps({'ok': False, 'msg': f'pywr import failed: {e}'})); sys.exit(0)\n\
        print(json.dumps({'ok': True, 'python_version': sys.version.split()[0], 'pywr_version': v}))";

    let output = match tokio::process::Command::new(&py)
        .arg("-c").arg(script)
        .output()
        .await
    {
        Ok(o) => o,
        Err(e) => return CheckPythonResult::Err {
            code: "PYTHON_SPAWN_FAILED".into(),
            message: e.to_string(),
        },
    };

    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    match serde_json::from_str::<Value>(&stdout) {
        Ok(v) if v.get("ok").and_then(|b| b.as_bool()) == Some(true) => {
            CheckPythonResult::Ok {
                python_version: v["python_version"].as_str().unwrap_or("").to_string(),
                pywr_version: v["pywr_version"].as_str().unwrap_or("").to_string(),
            }
        }
        Ok(v) => CheckPythonResult::Err {
            code: "PYWR_IMPORT_FAILED".into(),
            message: v["msg"].as_str().unwrap_or("pywr import failed").to_string(),
        },
        Err(_) => CheckPythonResult::Err {
            code: "PYTHON_SPAWN_FAILED".into(),
            message: format!("Unparseable check output: {}", stdout),
        },
    }
}

// ============================================================================
// APP ENTRY POINT
// ============================================================================

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(RunState::default())
        .invoke_handler(tauri::generate_handler![
            open_file_dialog,
            open_image_dialog,
            save_file_dialog,
            open_csv_dialog,
            open_results_dialog,
            read_csv_columns,
            read_csv_preview,
            read_h5_list,
            read_h5_preview,
            parse_model,
            validate_model_cmd,
            add_recorders_cmd,
            export_model,
            save_layout_file,
            read_layout_file,
            run_model,
            cancel_run,
            check_python,
            quit_app,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

// ============================================================================
// UNIT TESTS
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // -----------------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------------

    fn valid_model() -> Value {
        json!({
            "nodes": [
                {"name": "Source", "type": "Input"},
                {"name": "Demand", "type": "Output"}
            ],
            "edges": [{"from_node": "Source", "to_node": "Demand"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        })
    }

    fn issues_for(model: &Value) -> Vec<ValidationIssue> {
        validate_model_inner(model)
    }

    fn has_code(issues: &[ValidationIssue], code: &str) -> bool {
        issues.iter().any(|i| i.code == code)
    }

    fn count_code(issues: &[ValidationIssue], code: &str) -> usize {
        issues.iter().filter(|i| i.code == code).count()
    }

    // -----------------------------------------------------------------------
    // Valid model — should produce no errors
    // -----------------------------------------------------------------------

    #[test]
    fn valid_model_has_no_errors() {
        let issues = issues_for(&valid_model());
        let errors: Vec<_> = issues.iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "unexpected errors: {:?}", errors);
    }

    // -----------------------------------------------------------------------
    // MODEL_STRUCTURE_ERROR
    // -----------------------------------------------------------------------

    #[test]
    fn error_on_non_object_model() {
        let issues = issues_for(&json!("not_an_object"));
        assert!(has_code(&issues, "MODEL_STRUCTURE_ERROR"));
    }

    #[test]
    fn error_when_nodes_missing() {
        let m = json!({
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MODEL_STRUCTURE_ERROR"));
    }

    #[test]
    fn error_when_timestepper_missing() {
        let m = json!({
            "nodes": [],
            "edges": []
        });
        assert!(has_code(&issues_for(&m), "MODEL_STRUCTURE_ERROR"));
    }

    #[test]
    fn error_when_timestepper_missing_start() {
        let m = json!({
            "nodes": [],
            "edges": [],
            "timestepper": {"end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn error_when_timestepper_missing_end() {
        let m = json!({
            "nodes": [],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn error_when_timestepper_missing_timestep() {
        let m = json!({
            "nodes": [],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31"}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    // -----------------------------------------------------------------------
    // DUPLICATE_NODE_NAME
    // -----------------------------------------------------------------------

    #[test]
    fn error_on_duplicate_node_name() {
        let m = json!({
            "nodes": [
                {"name": "Same", "type": "Input"},
                {"name": "Same", "type": "Output"}
            ],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "DUPLICATE_NODE_NAME"));
    }

    // -----------------------------------------------------------------------
    // MISSING_REQUIRED_FIELD on nodes
    // -----------------------------------------------------------------------

    #[test]
    fn error_on_node_missing_name() {
        let m = json!({
            "nodes": [{"type": "Input"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn error_on_node_missing_type() {
        let m = json!({
            "nodes": [{"name": "N"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn error_on_storage_missing_max_volume() {
        let m = json!({
            "nodes": [{"name": "S", "type": "Storage"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn no_error_storage_with_max_volume() {
        let m = json!({
            "nodes": [{"name": "S", "type": "Storage", "max_volume": 1000}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let errors: Vec<_> = issues_for(&m).into_iter().filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "unexpected errors: {:?}", errors);
    }

    #[test]
    fn error_on_aggregatednode_missing_nodes_field() {
        let m = json!({
            "nodes": [{"name": "Agg", "type": "AggregatedNode"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    #[test]
    fn error_on_piecewiselink_missing_nsteps() {
        let m = json!({
            "nodes": [{"name": "PL", "type": "PiecewiseLink"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "MISSING_REQUIRED_FIELD"));
    }

    // -----------------------------------------------------------------------
    // INVALID_NODE_TYPE
    // -----------------------------------------------------------------------

    #[test]
    fn error_on_unknown_node_type() {
        let m = json!({
            "nodes": [{"name": "N", "type": "FakeNodeType"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "INVALID_NODE_TYPE"));
    }

    #[test]
    fn valid_all_known_node_types() {
        let known_types = [
            "input", "output", "link", "catchment", "storage", "reservoir",
            "river", "rivergauge", "riversplit", "losslink", "breaklink",
            "aggregatednode",
        ];
        for t in &known_types {
            let extra = if *t == "storage" { json!({"max_volume": 1000}) }
                else if *t == "aggregatednode" { json!({"nodes": []}) }
                else { json!({}) };
            let mut node = json!({"name": "N", "type": t});
            if let (Some(n_obj), Some(e_obj)) = (node.as_object_mut(), extra.as_object()) {
                for (k, v) in e_obj { n_obj.insert(k.clone(), v.clone()); }
            }
            let m = json!({
                "nodes": [node],
                "edges": [],
                "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
            });
            let errs: Vec<_> = issues_for(&m).into_iter()
                .filter(|i| i.severity == "error").collect();
            assert!(errs.is_empty(), "type '{}' should not produce errors but got: {:?}", t, errs);
        }
    }

    // -----------------------------------------------------------------------
    // ORPHANED_EDGE
    // -----------------------------------------------------------------------

    #[test]
    fn error_on_edge_referencing_missing_node() {
        let m = json!({
            "nodes": [{"name": "A", "type": "Input"}],
            "edges": [{"from_node": "A", "to_node": "GHOST"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "ORPHANED_EDGE"));
    }

    #[test]
    fn no_orphaned_edge_for_valid_connection() {
        let issues = issues_for(&valid_model());
        assert!(!has_code(&issues, "ORPHANED_EDGE"));
    }

    // -----------------------------------------------------------------------
    // UNCONNECTED_NODE warning
    // -----------------------------------------------------------------------

    #[test]
    fn warning_unconnected_node_when_no_edges() {
        let m = json!({
            "nodes": [{"name": "Lone", "type": "Link"}],
            "edges": [],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "UNCONNECTED_NODE"));
    }

    #[test]
    fn no_unconnected_warning_for_connected_nodes() {
        let issues = issues_for(&valid_model());
        assert!(!has_code(&issues, "UNCONNECTED_NODE"));
    }

    #[test]
    fn virtual_nodes_exempt_from_unconnected_warning() {
        let virtual_types = [
            "VirtualStorage", "AnnualVirtualStorage",
            "SeasonalVirtualStorage", "MonthlyVirtualStorage",
            "RollingVirtualStorage", "AggregatedNode", "AggregatedStorage",
        ];
        for vt in &virtual_types {
            let extra = if *vt == "AggregatedNode" || *vt == "AnnualVirtualStorage"
                || *vt == "VirtualStorage" || *vt == "SeasonalVirtualStorage"
                || *vt == "MonthlyVirtualStorage" || *vt == "RollingVirtualStorage" {
                    json!({"nodes": []})
                } else if *vt == "AggregatedStorage" {
                    json!({"storages": []})
                } else if *vt == "AnnualVirtualStorage" {
                    json!({"nodes": [], "max_volume": 0})
                } else {
                    json!({})
                };
            let mut node = json!({"name": "V", "type": vt});
            if let (Some(n_obj), Some(e_obj)) = (node.as_object_mut(), extra.as_object()) {
                for (k, v) in e_obj { n_obj.insert(k.clone(), v.clone()); }
            }
            let m = json!({
                "nodes": [node],
                "edges": [],
                "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
            });
            assert!(!has_code(&issues_for(&m), "UNCONNECTED_NODE"),
                "virtual type '{}' should not trigger UNCONNECTED_NODE", vt);
        }
    }

    // -----------------------------------------------------------------------
    // NO_RECORDER — must NOT appear (removed from validator)
    // -----------------------------------------------------------------------

    #[test]
    fn no_recorder_warning_never_emitted() {
        // This warning was removed because it fires for every node during editing
        let m = json!({
            "nodes": [
                {"name": "A", "type": "Input"},
                {"name": "B", "type": "Output"}
            ],
            "edges": [{"from_node": "A", "to_node": "B"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(!has_code(&issues_for(&m), "NO_RECORDER"),
            "NO_RECORDER should never be emitted");
    }

    // -----------------------------------------------------------------------
    // UNREACHABLE_DEMAND warning
    // -----------------------------------------------------------------------

    #[test]
    fn warning_unreachable_demand_when_output_has_no_source() {
        let m = json!({
            "nodes": [
                {"name": "Mid", "type": "Link"},
                {"name": "Demand", "type": "Output"}
            ],
            "edges": [{"from_node": "Mid", "to_node": "Demand"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(has_code(&issues_for(&m), "UNREACHABLE_DEMAND"));
    }

    #[test]
    fn no_unreachable_demand_when_source_is_upstream() {
        let issues = issues_for(&valid_model());
        assert!(!has_code(&issues, "UNREACHABLE_DEMAND"));
    }

    #[test]
    fn no_unreachable_demand_for_catchment_upstream() {
        let m = json!({
            "nodes": [
                {"name": "C", "type": "Catchment"},
                {"name": "D", "type": "Output"}
            ],
            "edges": [{"from_node": "C", "to_node": "D"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(!has_code(&issues_for(&m), "UNREACHABLE_DEMAND"));
    }

    #[test]
    fn unreachable_demand_through_chain_of_links() {
        // Input → Link → Link → Output should NOT trigger UNREACHABLE_DEMAND
        let m = json!({
            "nodes": [
                {"name": "Src", "type": "Input"},
                {"name": "L1",  "type": "Link"},
                {"name": "L2",  "type": "Link"},
                {"name": "Out", "type": "Output"}
            ],
            "edges": [
                {"from_node": "Src", "to_node": "L1"},
                {"from_node": "L1",  "to_node": "L2"},
                {"from_node": "L2",  "to_node": "Out"}
            ],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        assert!(!has_code(&issues_for(&m), "UNREACHABLE_DEMAND"));
    }

    // -----------------------------------------------------------------------
    // validate_model_cmd return structure
    // -----------------------------------------------------------------------

    #[test]
    fn cmd_returns_ok_true_with_errors_and_warnings_keys() {
        let result = validate_model_cmd(valid_model());
        assert_eq!(result["ok"], json!(true));
        assert!(result["data"]["errors"].is_array());
        assert!(result["data"]["warnings"].is_array());
    }

    #[test]
    fn cmd_returns_ok_false_for_non_object() {
        let result = validate_model_cmd(json!("bad"));
        assert_eq!(result["ok"], json!(false));
    }

    // -----------------------------------------------------------------------
    // add_recorders_inner
    // -----------------------------------------------------------------------

    #[test]
    fn add_recorders_adds_flow_recorder_for_input() {
        let m = json!({
            "nodes": [{"name": "Src", "type": "Input"}],
            "edges": [],
            "recorders": {},
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let (updated, added) = add_recorders_inner(m);
        assert!(!added.is_empty(), "should have added a recorder");
        let recs = updated["recorders"].as_object().unwrap();
        let has_flow = recs.values().any(|v| {
            v["type"] == "NumpyArrayNodeRecorder" && v["node"] == "Src"
        });
        assert!(has_flow, "should have a NumpyArrayNodeRecorder for Src");
    }

    #[test]
    fn add_recorders_adds_storage_recorder_for_storage() {
        let m = json!({
            "nodes": [{"name": "Res", "type": "Storage", "max_volume": 1000}],
            "edges": [],
            "recorders": {},
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let (updated, _) = add_recorders_inner(m);
        let recs = updated["recorders"].as_object().unwrap();
        let has_storage = recs.values().any(|v| {
            v["type"] == "NumpyArrayStorageRecorder" && v["node"] == "Res"
        });
        assert!(has_storage, "should have a NumpyArrayStorageRecorder for Res");
    }

    #[test]
    fn add_recorders_does_not_duplicate_existing_recorder() {
        let m = json!({
            "nodes": [{"name": "N", "type": "Input"}],
            "edges": [],
            "recorders": {
                "N_recorder": {"type": "NumpyArrayNodeRecorder", "node": "N"}
            },
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let (_, added) = add_recorders_inner(m);
        // Nothing should be added because the recorder already exists
        assert!(added.is_empty(), "should not duplicate existing recorder");
    }

    #[test]
    fn add_recorders_skips_aggregated_nodes() {
        let m = json!({
            "nodes": [{"name": "Agg", "type": "AggregatedNode", "nodes": []}],
            "edges": [],
            "recorders": {},
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let (_, added) = add_recorders_inner(m);
        assert!(added.is_empty(), "AggregatedNode should be skipped");
    }

    // -----------------------------------------------------------------------
    // type_key normalisation
    // -----------------------------------------------------------------------

    #[test]
    fn type_key_lowercases() {
        assert_eq!(type_key("Input"), "input");
        assert_eq!(type_key("RiverSplitWithGauge"), "riversplitwithgauge");
        assert_eq!(type_key("STORAGE"), "storage");
    }

    // -----------------------------------------------------------------------
    // Edge format normalisation in parse_model
    // -----------------------------------------------------------------------

    #[test]
    fn validate_handles_array_edge_format() {
        // Pywr's canonical edge shape is ["from", "to"]. As of v1.6.0 Pywrscope
        // stores edges this way in memory and emits them this way on save.
        // The validator must accept arrays directly (no normalisation step needed).
        let m = json!({
            "nodes": [
                {"name": "A", "type": "Input"},
                {"name": "B", "type": "Output"}
            ],
            "edges": [["A", "B"]],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let errors: Vec<_> = issues_for(&m).into_iter()
            .filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "clean array-edge model should have no errors");
    }

    #[test]
    fn validate_still_accepts_legacy_object_edge_format() {
        // Files saved by Pywrscope <= v1.5.x used object form. Validator must
        // still accept them so users can open old files without migration.
        let m = json!({
            "nodes": [
                {"name": "A", "type": "Input"},
                {"name": "B", "type": "Output"}
            ],
            "edges": [{"from_node": "A", "to_node": "B"}],
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1}
        });
        let errors: Vec<_> = issues_for(&m).into_iter()
            .filter(|i| i.severity == "error").collect();
        assert!(errors.is_empty(), "legacy object-edge model should still parse");
    }

    // -----------------------------------------------------------------------
    // forward_event_lines — pure stdout-line forwarder used by run_model.
    // Decoupling it from tauri::AppHandle::emit lets us test the protocol
    // without standing up a full Tauri app in the test runtime.
    // -----------------------------------------------------------------------

    #[tokio::test]
    async fn forward_event_lines_parses_well_formed_events_in_order() {
        let input: &[u8] = b"{\"type\":\"started\",\"total\":3}\n\
                             {\"type\":\"progress\",\"step\":1}\n\
                             {\"type\":\"progress\",\"step\":2}\n\
                             {\"type\":\"done\"}\n";
        let reader = tokio::io::BufReader::new(input);
        let mut events: Vec<Value> = vec![];
        forward_event_lines(reader, |p| events.push(p)).await;

        assert_eq!(events.len(), 4);
        assert_eq!(events[0]["type"], "started");
        assert_eq!(events[0]["total"], 3);
        assert_eq!(events[1]["type"], "progress");
        assert_eq!(events[1]["step"], 1);
        assert_eq!(events[3]["type"], "done");
    }

    #[tokio::test]
    async fn forward_event_lines_wraps_garbage_as_log_warning() {
        // A non-JSON line on the event stream should not break forwarding
        // (e.g. a stray print() in the bridge script). It must surface as a
        // log/warn so we don't silently drop diagnostic output.
        let input: &[u8] = b"this is not json\n{\"type\":\"done\"}\n";
        let reader = tokio::io::BufReader::new(input);
        let mut events: Vec<Value> = vec![];
        forward_event_lines(reader, |p| events.push(p)).await;

        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "log");
        assert_eq!(events[0]["level"], "warn");
        assert_eq!(events[0]["message"], "this is not json");
        assert_eq!(events[1]["type"], "done");
    }

    #[tokio::test]
    async fn forward_event_lines_handles_empty_stream() {
        let input: &[u8] = b"";
        let reader = tokio::io::BufReader::new(input);
        let mut events: Vec<Value> = vec![];
        forward_event_lines(reader, |p| events.push(p)).await;
        assert!(events.is_empty(), "empty stream should yield no events");
    }

    #[tokio::test]
    async fn forward_event_lines_skips_blank_lines_as_log_noise() {
        // A blank line is not valid JSON either; it should fall into the log
        // bucket. Documents the edge case so future refactors don't quietly
        // drop blank lines (which would mask trailing-newline buffering bugs).
        let input: &[u8] = b"\n{\"type\":\"done\"}\n";
        let reader = tokio::io::BufReader::new(input);
        let mut events: Vec<Value> = vec![];
        forward_event_lines(reader, |p| events.push(p)).await;
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["type"], "log");
        assert_eq!(events[1]["type"], "done");
    }

    // -----------------------------------------------------------------------
    // python_binary path resolution — guards the cross-platform layout
    // assumption (macOS/Linux: bin/python3, Windows: python.exe).
    // -----------------------------------------------------------------------

    #[test]
    fn python_binary_uses_bin_python3_on_unix() {
        if cfg!(unix) {
            let p = python_binary(&PathBuf::from("/runtime"));
            assert_eq!(p, PathBuf::from("/runtime/bin/python3"));
        }
    }

    #[test]
    fn python_binary_uses_python_exe_on_windows() {
        if cfg!(windows) {
            let p = python_binary(&PathBuf::from("C:\\runtime"));
            assert_eq!(p, PathBuf::from("C:\\runtime\\python.exe"));
        }
    }

    #[test]
    fn bridge_script_lives_at_runtime_root() {
        // The setup script copies run_pywr.py into the runtime root so the
        // entire bundle ships as one resource entry. Locking this in keeps
        // the Rust resolver and the bash setup script in agreement.
        let p = bridge_script(&PathBuf::from("/runtime"));
        assert_eq!(p, PathBuf::from("/runtime/run_pywr.py"));
    }

    #[test]
    fn next_run_id_is_unique_per_call() {
        let a = next_run_id();
        let b = next_run_id();
        assert_ne!(a, b, "consecutive run ids must differ");
        assert!(a.starts_with("run-"));
        assert!(b.starts_with("run-"));
    }

    // -----------------------------------------------------------------------
    // validate_user_path — guards every command that touches a user-supplied
    // path. The test set encodes the two threat classes we want to keep out
    // of std::fs: relative paths (resolve against backend cwd) and ".."
    // traversal (escape from the intended directory).
    // -----------------------------------------------------------------------

    #[test]
    fn validate_user_path_accepts_plain_absolute_path() {
        if cfg!(unix) {
            assert!(validate_user_path("/Users/me/Documents/model.json").is_ok());
        } else {
            assert!(validate_user_path("C:\\Users\\me\\model.json").is_ok());
        }
    }

    #[test]
    fn validate_user_path_rejects_relative_path() {
        assert!(validate_user_path("model.json").is_err());
        assert!(validate_user_path("./model.json").is_err());
        assert!(validate_user_path("subdir/model.json").is_err());
    }

    #[test]
    fn validate_user_path_rejects_parent_dir_traversal() {
        // The classic CVE shape — absolute root but `..` segments climb out.
        if cfg!(unix) {
            assert!(validate_user_path("/Users/me/../../etc/passwd").is_err());
            assert!(validate_user_path("/tmp/../etc/shadow").is_err());
        } else {
            assert!(validate_user_path("C:\\Users\\me\\..\\..\\Windows\\System32").is_err());
        }
    }

    #[test]
    fn validate_user_path_rejects_empty() {
        assert!(validate_user_path("").is_err());
    }

    #[test]
    fn parse_model_rejects_relative_path() {
        let v = parse_model("relative/path.json".into());
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn parse_model_rejects_parent_dir_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/passwd" } else { "C:\\..\\Windows" };
        let v = parse_model(bad.into());
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn export_model_rejects_relative_path() {
        let v = export_model(json!({"nodes": []}), "out.json".into());
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn export_model_rejects_parent_dir_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/passwd" } else { "C:\\..\\boot.ini" };
        let v = export_model(json!({"nodes": []}), bad.into());
        assert_eq!(v["ok"], json!(false));
    }

    #[test]
    fn save_layout_file_rejects_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/evil" } else { "C:\\..\\evil" };
        assert!(save_layout_file(bad.into(), "x".into()).is_err());
    }

    #[test]
    fn read_layout_file_returns_none_on_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/passwd" } else { "C:\\..\\evil" };
        assert!(read_layout_file(bad.into()).is_none());
    }

    #[test]
    fn read_csv_columns_returns_empty_on_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/passwd" } else { "C:\\..\\evil" };
        assert!(read_csv_columns(bad.into()).is_empty());
    }

    #[test]
    fn read_csv_preview_returns_error_envelope_on_traversal() {
        let bad = if cfg!(unix) { "/tmp/../etc/passwd" } else { "C:\\..\\evil" };
        let p = read_csv_preview(bad.into(), 10);
        assert!(!p.ok);
        assert!(p.error.is_some());
    }

    // -----------------------------------------------------------------------
    // parse → export → parse round trip
    //
    // The v1.6.0 release regressed because edges were stored as
    // {from_node, to_node} objects in memory; saving emitted those objects,
    // and Pywr core (which expects arrays) refused to load them. A round-trip
    // test against the shipped examples would have caught this immediately —
    // the second parse_model would have failed on the object-shaped edges or
    // (more likely) produced a different data shape than the first.
    //
    // These tests pin two things:
    //   1. Both example files round-trip with no semantic drift.
    //   2. parse_model normalises legacy object-edges to canonical arrays
    //      AND re-parsing the export keeps them as arrays.
    // -----------------------------------------------------------------------

    fn example_path(relative: &str) -> PathBuf {
        // Cargo.toml lives at src-tauri/; examples/ is one level up.
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri has a parent")
            .join("examples")
            .join(relative)
    }

    fn round_trip(example: &str) {
        let src = example_path(example);
        assert!(src.exists(), "missing example fixture: {}", src.display());

        // First parse — produces the canonical data envelope the UI consumes.
        let first = parse_model(src.to_string_lossy().to_string());
        assert_eq!(
            first["ok"], json!(true),
            "first parse_model({}) failed: {:?}", example, first.get("error")
        );

        // Export the parsed data to a tempfile. We rebuild a Pywr-shaped
        // top-level object from the parser's data envelope (which splits the
        // file into nodes/edges/parameters/recorders/timestepper/metadata).
        let data = &first["data"];
        let mut model = serde_json::Map::new();
        for key in &["nodes", "edges", "parameters", "recorders", "timestepper", "metadata"] {
            if let Some(v) = data.get(*key) {
                model.insert((*key).into(), v.clone());
            }
        }
        let model_value = Value::Object(model);

        // Write to a unique tempfile so parallel test runs don't collide.
        let tmp = std::env::temp_dir().join(format!(
            "pywrscope_round_trip_{}_{}_{}.json",
            example.replace('/', "_"),
            std::process::id(),
            next_run_id(),
        ));
        let export = export_model(model_value, tmp.to_string_lossy().to_string());
        assert_eq!(
            export["ok"], json!(true),
            "export_model failed for {}: {:?}", example, export.get("error")
        );

        // Re-parse the exported file.
        let second = parse_model(tmp.to_string_lossy().to_string());
        assert_eq!(
            second["ok"], json!(true),
            "second parse_model failed for {}: {:?}", example, second.get("error")
        );

        // Semantic equality across the round trip. parse_model is the
        // canonicalisation step (legacy edge objects → arrays), so if the
        // first parse normalised anything the second parse will see the
        // already-normalised form — equality must hold either way.
        assert_eq!(
            first["data"], second["data"],
            "round-trip drift in {}: first vs second parse differ", example
        );

        // Lock in the edge-shape invariant the v1.6.0 fix established:
        // edges MUST be arrays on disk and after parse, never objects.
        let edges = second["data"]["edges"].as_array().expect("edges is an array");
        for (i, e) in edges.iter().enumerate() {
            assert!(e.is_array(), "round-tripped edge {} in {} is not an array: {:?}", i, example, e);
        }

        let _ = std::fs::remove_file(&tmp);
    }

    #[test]
    fn round_trip_preserves_bordon_gw_example() {
        round_trip("bordon_gw/bordon_gw.json");
    }

    #[test]
    fn round_trip_preserves_thames_supply_example() {
        round_trip("thames_supply/thames_supply.json");
    }

    #[test]
    fn round_trip_normalises_legacy_object_edges() {
        // Synthesise a v1.5.x-shaped fixture (edges as {from_node, to_node}
        // objects). After one parse_model→export_model→parse_model cycle the
        // edges must be canonical arrays, and a second cycle must be a no-op
        // (idempotent normalisation).
        let model = json!({
            "metadata": {"title": "legacy fixture"},
            "timestepper": {"start": "2020-01-01", "end": "2020-12-31", "timestep": 1},
            "nodes": [
                {"name": "A", "type": "Input"},
                {"name": "B", "type": "Output"}
            ],
            "edges": [{"from_node": "A", "to_node": "B"}],
            "parameters": {},
            "recorders": {}
        });

        let tmp_in = std::env::temp_dir().join(format!("legacy_edges_in_{}.json", next_run_id()));
        std::fs::write(&tmp_in, serde_json::to_string(&model).unwrap()).unwrap();

        let first = parse_model(tmp_in.to_string_lossy().to_string());
        assert_eq!(first["ok"], json!(true), "first parse failed");
        let edges_after_parse = first["data"]["edges"].as_array().unwrap();
        assert_eq!(edges_after_parse.len(), 1);
        assert!(
            edges_after_parse[0].is_array(),
            "parse_model must normalise object-edges to arrays, got {:?}",
            edges_after_parse[0]
        );

        let mut roundtrip_model = serde_json::Map::new();
        for key in &["nodes", "edges", "parameters", "recorders", "timestepper", "metadata"] {
            if let Some(v) = first["data"].get(*key) {
                roundtrip_model.insert((*key).into(), v.clone());
            }
        }
        let tmp_out = std::env::temp_dir().join(format!("legacy_edges_out_{}.json", next_run_id()));
        let export = export_model(Value::Object(roundtrip_model), tmp_out.to_string_lossy().to_string());
        assert_eq!(export["ok"], json!(true));

        let second = parse_model(tmp_out.to_string_lossy().to_string());
        assert_eq!(second["ok"], json!(true));
        assert_eq!(first["data"], second["data"], "second parse must be a no-op");

        let _ = std::fs::remove_file(&tmp_in);
        let _ = std::fs::remove_file(&tmp_out);
    }
}

// src/tauri_bridge.ts
// Implements the window.pywr API using Tauri invoke() instead of Electron IPC.
// Install once at startup (src/index.tsx). No React components need to change.

import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type {
  PywrRunEvent,
  PywrRunHandle,
  CheckPythonResult,
} from './types/pywr';

type ApiBody = Record<string, unknown>;

// Route the legacy callApi() calls to the appropriate Tauri commands.
async function callApi(route: string, body: unknown): Promise<unknown> {
  const b = (body ?? {}) as ApiBody;
  switch (route) {
    case '/api/parse':
      return invoke('parse_model', { jsonPath: b['json_path'] });
    case '/api/validate':
      return invoke('validate_model_cmd', { model: b['model'] });
    case '/api/add-recorders':
      return invoke('add_recorders_cmd', { model: b['model'] });
    case '/api/export':
      return invoke('export_model', { model: b['model'], outputPath: b['output_path'] });
    default:
      return { ok: false, error: `Unknown route: ${route}` };
  }
}

export function installTauriBridge(): void {
  window.pywr = {
    // Returns the absolute path to the selected .json file, or null if cancelled.
    openFile: () => invoke<string | null>('open_file_dialog'),

    // Returns a convertFileSrc() URL for the selected image (usable directly as
    // an <img src> in the WebView). Canvas.tsx uses backgroundImage as src directly.
    openImage: async () => {
      const path = await invoke<string | null>('open_image_dialog');
      return path ? convertFileSrc(path) : null;
    },

    // Returns the chosen save path, or null if cancelled.
    saveFile: (defaultPath: string) =>
      invoke<string | null>('save_file_dialog', { defaultPath }),

    // Routes to the appropriate Rust command based on route string.
    callApi,

    // Write raw string content to disk (used for .layout.json sidecar).
    saveLayoutFile: (path: string, content: string) =>
      invoke<void>('save_layout_file', { path, content }),

    // Read file content from disk; returns null if file does not exist.
    readLayoutFile: (path: string) =>
      invoke<string | null>('read_layout_file', { path }),

    // Returns the absolute path to the selected .csv file, or null.
    openCsv: () => invoke<string | null>('open_csv_dialog'),

    // Returns the column names from the CSV header row.
    readCsvColumns: (path: string) =>
      invoke<string[]>('read_csv_columns', { path }),

    // Results-file picker — accepts both CSV and HDF5. Returns absolute path
    // or null on cancel. The single picker simplifies the Results panel UX
    // (one button, one dialog) at the cost of one extra dialog entry.
    openResults: () => invoke<string | null>('open_results_dialog'),

    // CSV preview: headers + head rows + total row count. Implemented in Rust
    // so we don't pay the python spawn cost for the common case.
    readCsvPreview: (path, maxRows) =>
      invoke('read_csv_preview', { path, maxRows }) as Promise<{
        ok: boolean;
        headers: string[];
        rows: string[][];
        total_rows: number;
        returned_rows: number;
        error: string | null;
      }>,

    // HDF5 helpers — delegated to bundled python (h5py via Pywr's tables dep).
    // The Rust side spawns python read_h5.py, parses the single-line JSON
    // result, and forwards it untyped. Frontend keeps the contract typed.
    readH5List: (path) =>
      invoke('read_h5_list', { path }) as Promise<{
        ok: boolean;
        datasets?: { name: string; shape: number[]; dtype: string; size: number }[];
        error?: string;
      }>,
    readH5Preview: (path, dataset, maxRows) =>
      invoke('read_h5_preview', { path, dataset, maxRows }) as Promise<{
        ok: boolean;
        headers?: string[];
        rows?: (string | number)[][];
        shape?: number[];
        total_rows?: number;
        returned_rows?: number;
        error?: string;
      }>,

    // Spawns the bundled Python interpreter against run_pywr.py for the given
    // model. Resolves with a handle whose eventName the caller passes to
    // onRunEvent to subscribe to the event stream. The run_id is what
    // cancelRun expects.
    runModel: (jsonPath: string, outDir: string) =>
      invoke<{ run_id: string; event_name: string }>(
        'run_model',
        { jsonPath, outDir },
      ).then((h): PywrRunHandle => ({ runId: h.run_id, eventName: h.event_name })),

    // Subscribes a handler to the per-run event channel. Returns an unlisten
    // function — the caller MUST call it on cleanup, otherwise the listener
    // outlives the React component and will reference stale state.
    onRunEvent: async (
      eventName: string,
      handler: (event: PywrRunEvent) => void,
    ): Promise<() => void> => {
      const unlisten = await listen<PywrRunEvent>(eventName, (e) => handler(e.payload));
      return unlisten;
    },

    // Sends SIGTERM to the underlying python child. The bridge script's signal
    // handler emits a {type:"cancelled"} event before exit; the Rust reader
    // task observes stdout EOF and reaps the child afterwards.
    cancelRun: (runId: string) => invoke<void>('cancel_run', { runId }),

    // One-shot health check on the bundled python: confirms the interpreter
    // exists and can import pywr. Used by the Run button to give actionable
    // diagnostics before spawning a real run.
    checkPython: () => invoke<CheckPythonResult>('check_python'),

    // Force-quit the app (bypasses window close events).
    quit: () => invoke<void>('quit_app'),
  };
}

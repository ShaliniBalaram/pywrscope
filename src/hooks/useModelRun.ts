// src/hooks/useModelRun.ts
// Owns the lifecycle of a single Pywr model run. The Tauri backend supports
// concurrent runs by ID, but the UI deliberately serialises to one at a time
// because (a) results panels are easier to reason about, and (b) running the
// same engine twice in parallel offers no UX win.
//
// Event flow: useModelRun.start() -> window.pywr.runModel() -> Rust spawns
// python -> python emits JSON-line events -> Rust forwards as Tauri events ->
// onRunEvent() listener in this hook -> setState transitions.

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PywrRunEvent,
  PywrRunErrorCode,
  PywrRunErrorEvent,
} from "../types/pywr";

// Idle is the only state from which start() is valid. Everything else implies
// either an active run or a terminal state the user must dismiss first — that
// invariant is enforced inside start() rather than the call sites.
export type RunStatus =
  | "idle"
  | "starting"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export interface RunOutputRef {
  name: string;
  path: string;
}

export interface RunStateView {
  status: RunStatus;
  runId: string | null;
  total: number;
  step: number;
  pct: number;
  date: string;
  outputs: RunOutputRef[];
  outDir: string | null;
  stats: { timesteps: number; scenarios: number; seconds: number } | null;
  error: { code: PywrRunErrorCode; message: string; traceback: string } | null;
  // Last N raw events as displayable strings. Bounded so a long run never
  // grows the array without bound; the panel only ever shows the tail anyway.
  log: string[];
}

const LOG_TAIL_LIMIT = 200;

const initial: RunStateView = {
  status: "idle",
  runId: null,
  total: 0,
  step: 0,
  pct: 0,
  date: "",
  outputs: [],
  outDir: null,
  stats: null,
  error: null,
  log: [],
};

// Default out-dir convention: <model-dir>/<model-stem>.results
// Lives next to the JSON so users can find results in Finder/Explorer without
// hunting a settings page. Override only when the caller has a reason.
function defaultOutDir(jsonPath: string): string {
  const sep = jsonPath.includes("\\") ? "\\" : "/";
  const lastSep = jsonPath.lastIndexOf(sep);
  const dir = lastSep >= 0 ? jsonPath.slice(0, lastSep) : ".";
  const filename = lastSep >= 0 ? jsonPath.slice(lastSep + 1) : jsonPath;
  const stem = filename.replace(/\.json$/i, "");
  return `${dir}${sep}${stem}.results`;
}

function appendLog(prev: string[], line: string): string[] {
  const next = [...prev, line];
  if (next.length > LOG_TAIL_LIMIT) {
    return next.slice(next.length - LOG_TAIL_LIMIT);
  }
  return next;
}

export interface UseModelRunReturn {
  state: RunStateView;
  start: (jsonPath: string, outDir?: string) => Promise<void>;
  cancel: () => Promise<void>;
  reset: () => void;
}

export function useModelRun(): UseModelRunReturn {
  const [state, setState] = useState<RunStateView>(initial);
  // Unlisten ref is per-run so a stale cancel() after a fresh start() doesn't
  // tear down the new listener. Rotation happens inside start().
  const unlistenRef = useRef<(() => void) | null>(null);

  // On unmount: drop the listener. React's strict-mode double-mount will
  // call this and then immediately re-run the start() that registered it,
  // so this is correct only because unlistenRef is rotated atomically.
  useEffect(() => {
    return () => {
      unlistenRef.current?.();
      unlistenRef.current = null;
    };
  }, []);

  const handleEvent = useCallback((event: PywrRunEvent) => {
    setState((prev) => {
      switch (event.type) {
        case "started":
          return {
            ...prev,
            status: "running",
            total: event.timesteps_total,
            log: appendLog(prev.log, `started ${event.model} (${event.timesteps_total} timesteps)`),
          };
        case "progress":
          return {
            ...prev,
            step: event.step,
            total: event.total,
            pct: event.pct,
            date: event.date,
          };
        case "done":
          return {
            ...prev,
            status: "done",
            outputs: event.outputs,
            stats: event.stats,
            pct: 100,
            log: appendLog(prev.log, `done in ${event.stats.seconds}s`),
          };
        case "error": {
          const ev = event as PywrRunErrorEvent;
          return {
            ...prev,
            status: "error",
            error: { code: ev.code, message: ev.message, traceback: ev.traceback },
            log: appendLog(prev.log, `error [${ev.code}] ${ev.message}`),
          };
        }
        case "cancelled":
          return {
            ...prev,
            status: "cancelled",
            log: appendLog(prev.log, "cancelled by user"),
          };
        case "log":
          return {
            ...prev,
            log: appendLog(prev.log, `[${event.level}] ${event.message}`),
          };
        default: {
          // Exhaustiveness guard — if the protocol grows, TypeScript will
          // flag this and force the union to be widened above.
          const _exhaustive: never = event;
          return prev;
        }
      }
    });
  }, []);

  const start = useCallback(async (jsonPath: string, outDir?: string) => {
    // Prevent overlapping runs. Terminal runs can be replaced by a fresh run;
    // dismissing the panel only hides it and leaves results available.
    setState((prev) => {
      if (prev.status === "running" || prev.status === "starting") {
        return prev;
      }
      return { ...initial, status: "starting" };
    });

    const resolvedOut = outDir ?? defaultOutDir(jsonPath);

    // Tear down any previous listener before registering a fresh one for the
    // new run. Forgetting this would leak listeners across runs and cause the
    // UI to reflect events from a prior run alongside the current.
    unlistenRef.current?.();
    unlistenRef.current = null;

    try {
      const handle = await window.pywr.runModel(jsonPath, resolvedOut);
      const unlisten = await window.pywr.onRunEvent(handle.eventName, handleEvent);
      unlistenRef.current = unlisten;
      setState((prev) => ({
        ...prev,
        runId: handle.runId,
        outDir: resolvedOut,
      }));
    } catch (e) {
      // The Rust command rejects on spawn failure (missing python, bad path).
      // Surface it as a typed error event so the UI panel renders the same way
      // it would for a script-side failure — single error rendering path.
      setState((prev) => ({
        ...prev,
        status: "error",
        error: {
          code: "RUNTIME_NOT_FOUND",
          message: e instanceof Error ? e.message : String(e),
          traceback: "",
        },
      }));
    }
  }, [handleEvent]);

  const cancel = useCallback(async () => {
    const id = state.runId;
    if (!id) return;
    try {
      await window.pywr.cancelRun(id);
    } catch (e) {
      // Cancellation failure is non-fatal — the child may have already exited.
      // Surface as a log entry rather than promoting to an error state.
      setState((prev) => ({
        ...prev,
        log: appendLog(prev.log, `cancel failed: ${e instanceof Error ? e.message : String(e)}`),
      }));
    }
  }, [state.runId]);

  const reset = useCallback(() => {
    unlistenRef.current?.();
    unlistenRef.current = null;
    setState(initial);
  }, []);

  return { state, start, cancel, reset };
}

// Exported for unit tests so the path-derivation rule lives in one place.
export const _internal = { defaultOutDir };

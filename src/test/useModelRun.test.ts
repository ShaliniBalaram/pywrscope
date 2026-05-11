// src/test/useModelRun.test.ts
// Unit tests for the useModelRun hook. The Tauri bridge is mocked so we can
// drive the event stream synchronously and assert state transitions; the real
// IPC + child-process pipeline is exercised by the Rust tests in src-tauri.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useModelRun, _internal } from '../hooks/useModelRun';
import type { PywrRunEvent } from '../types/pywr';

// Captured handler from the most recent onRunEvent call. Tests drive this
// directly to simulate events the Rust backend would normally emit.
let lastHandler: ((event: PywrRunEvent) => void) | null = null;
const unlistenSpy = vi.fn();

function emitToHook(event: PywrRunEvent) {
  if (!lastHandler) throw new Error('No handler registered');
  lastHandler(event);
}

beforeEach(() => {
  lastHandler = null;
  unlistenSpy.mockClear();
  Object.defineProperty(window, 'pywr', {
    value: {
      runModel: vi.fn(async () => ({ runId: 'run-0', eventName: 'pywr://run/run-0' })),
      onRunEvent: vi.fn(async (_eventName: string, h: (e: PywrRunEvent) => void) => {
        lastHandler = h;
        return unlistenSpy;
      }),
      cancelRun: vi.fn(async () => {}),
      checkPython: vi.fn(),
      // Stubs for the unrelated bits of the bridge — present so TS structural
      // typing accepts the mock. Tests that need them fill in.
      openFile: vi.fn(), saveFile: vi.fn(), callApi: vi.fn(),
      saveLayoutFile: vi.fn(), readLayoutFile: vi.fn(),
      openCsv: vi.fn(), readCsvColumns: vi.fn(),
      quit: vi.fn(), openImage: vi.fn(),
    },
    writable: true,
    configurable: true,
  });
});

describe('useModelRun — initial state', () => {
  it('starts idle with no run id', () => {
    const { result } = renderHook(() => useModelRun());
    expect(result.current.state.status).toBe('idle');
    expect(result.current.state.runId).toBeNull();
    expect(result.current.state.outputs).toEqual([]);
  });
});

describe('useModelRun — happy path', () => {
  it('transitions starting → running → done', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/m.json'); });

    // After start() awaits, the listener is wired; we can drive events.
    expect(result.current.state.runId).toBe('run-0');
    expect(result.current.state.outDir).toBe('/tmp/m.results');

    act(() => emitToHook({ type: 'started', model: '/tmp/m.json', timesteps_total: 100 }));
    expect(result.current.state.status).toBe('running');
    expect(result.current.state.total).toBe(100);

    act(() => emitToHook({ type: 'progress', step: 50, total: 100, pct: 50, date: '2024-06-01' }));
    expect(result.current.state.step).toBe(50);
    expect(result.current.state.pct).toBe(50);
    expect(result.current.state.date).toBe('2024-06-01');

    act(() => emitToHook({
      type: 'done',
      outputs: [{ name: 'summary', path: '/tmp/m.results/summary.json' }],
      stats: { timesteps: 100, scenarios: 1, seconds: 0.42 },
    }));
    expect(result.current.state.status).toBe('done');
    expect(result.current.state.outputs).toHaveLength(1);
    expect(result.current.state.stats?.seconds).toBe(0.42);
    expect(result.current.state.pct).toBe(100);
  });
});

describe('useModelRun — error path', () => {
  it('records typed error from MODEL_LOAD_FAILED event', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/bad.json'); });

    act(() => emitToHook({
      type: 'error',
      code: 'MODEL_LOAD_FAILED',
      message: 'Pywr could not load',
      traceback: 'File "x.py", line 1\n...',
    }));

    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error?.code).toBe('MODEL_LOAD_FAILED');
    expect(result.current.state.error?.traceback).toContain('File "x.py"');
  });

  it('surfaces spawn failure as RUNTIME_NOT_FOUND error state', async () => {
    (window.pywr.runModel as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('python not found'));
    const { result } = renderHook(() => useModelRun());

    await act(async () => { await result.current.start('/tmp/m.json'); });
    expect(result.current.state.status).toBe('error');
    expect(result.current.state.error?.code).toBe('RUNTIME_NOT_FOUND');
    expect(result.current.state.error?.message).toContain('python not found');
  });
});

describe('useModelRun — cancellation', () => {
  it('cancel() invokes bridge.cancelRun with runId', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/m.json'); });
    act(() => emitToHook({ type: 'started', model: '/tmp/m.json', timesteps_total: 10 }));

    await act(async () => { await result.current.cancel(); });
    expect(window.pywr.cancelRun).toHaveBeenCalledWith('run-0');
  });

  it('cancelled event transitions to cancelled state', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/m.json'); });
    act(() => emitToHook({ type: 'cancelled' }));
    expect(result.current.state.status).toBe('cancelled');
  });

  it('cancel() is a no-op when no run is active', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.cancel(); });
    expect(window.pywr.cancelRun).not.toHaveBeenCalled();
  });
});

describe('useModelRun — listener lifecycle', () => {
  it('reset() unsubscribes and returns to idle', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/m.json'); });
    act(() => emitToHook({ type: 'done', outputs: [], stats: { timesteps: 1, scenarios: 1, seconds: 0 } }));

    act(() => result.current.reset());
    expect(result.current.state.status).toBe('idle');
    expect(unlistenSpy).toHaveBeenCalled();
  });

  it('a second start() tears down the previous listener', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/a.json'); });
    const firstUnlisten = unlistenSpy.mock.calls.length;

    await act(async () => { await result.current.start('/tmp/b.json'); });
    // unlisten was called once between the two starts (rotating the listener).
    await waitFor(() => {
      expect(unlistenSpy.mock.calls.length).toBeGreaterThan(firstUnlisten);
    });
  });
});

describe('useModelRun — log accumulation', () => {
  it('appends a log entry per event', async () => {
    const { result } = renderHook(() => useModelRun());
    await act(async () => { await result.current.start('/tmp/m.json'); });

    act(() => emitToHook({ type: 'started', model: '/tmp/m.json', timesteps_total: 1 }));
    act(() => emitToHook({ type: 'log', level: 'info', message: 'hello' }));
    act(() => emitToHook({ type: 'log', level: 'warn', message: 'careful' }));

    const log = result.current.state.log;
    expect(log.some((l) => l.includes('started'))).toBe(true);
    expect(log.some((l) => l.includes('hello'))).toBe(true);
    expect(log.some((l) => l.includes('careful'))).toBe(true);
  });
});

describe('defaultOutDir derivation', () => {
  it('places results next to the JSON with .results suffix', () => {
    expect(_internal.defaultOutDir('/Users/me/model.json'))
      .toBe('/Users/me/model.results');
  });

  it('handles Windows-style paths', () => {
    expect(_internal.defaultOutDir('C:\\Users\\me\\model.json'))
      .toBe('C:\\Users\\me\\model.results');
  });

  it('handles a bare filename with no directory', () => {
    // sep heuristic picks "/" when no backslash is present, so the bare
    // filename resolves to "./model.results" rather than fighting the OS.
    expect(_internal.defaultOutDir('model.json')).toBe('./model.results');
  });
});

// src/test/RunPanel.test.tsx
// Component tests for the RunPanel — verifies render branches per status.
// The panel is a pure view of RunStateView; tests construct the state object
// directly rather than going through useModelRun.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RunPanel } from '../components/RunPanel';
import type { RunStateView } from '../hooks/useModelRun';

function baseState(overrides: Partial<RunStateView> = {}): RunStateView {
  return {
    status: 'idle',
    runId: null,
    total: 0,
    step: 0,
    pct: 0,
    date: '',
    outputs: [],
    outDir: null,
    stats: null,
    error: null,
    log: [],
    ...overrides,
  };
}

describe('RunPanel — running state', () => {
  it('shows progress, step counts and Cancel button', () => {
    const onCancel = vi.fn();
    const onClose = vi.fn();
    render(
      <RunPanel
        state={baseState({
          status: 'running', runId: 'run-1',
          step: 42, total: 100, pct: 42, date: '2024-06-01',
        })}
        onCancel={onCancel}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(/Running/)).toBeInTheDocument();
    expect(screen.getByText(/42 \/ 100 steps/)).toBeInTheDocument();
    expect(screen.getByText(/2024-06-01/)).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('disables the close button while a run is active', () => {
    render(
      <RunPanel
        state={baseState({ status: 'running' })}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    const close = screen.getByLabelText('Close run panel') as HTMLButtonElement;
    expect(close.disabled).toBe(true);
  });
});

describe('RunPanel — done state', () => {
  it('shows outputs list and a Dismiss button', () => {
    const onClose = vi.fn();
    render(
      <RunPanel
        state={baseState({
          status: 'done',
          step: 100, total: 100, pct: 100,
          outputs: [
            { name: 'summary', path: '/tmp/m.results/summary.json' },
            { name: 'flow', path: '/tmp/m.results/flow.csv' },
          ],
          outDir: '/tmp/m.results',
          stats: { timesteps: 100, scenarios: 1, seconds: 1.23 },
        })}
        onCancel={vi.fn()}
        onClose={onClose}
      />,
    );

    expect(screen.getByText('Run complete')).toBeInTheDocument();
    expect(screen.getByText(/Outputs \(2\):/)).toBeInTheDocument();
    expect(screen.getByText('/tmp/m.results/summary.json')).toBeInTheDocument();
    expect(screen.getByText('/tmp/m.results/flow.csv')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Dismiss'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('RunPanel — error state', () => {
  it('renders the typed error code, message, and a collapsible traceback', () => {
    render(
      <RunPanel
        state={baseState({
          status: 'error',
          error: {
            code: 'MODEL_LOAD_FAILED',
            message: 'Pywr could not load the model',
            traceback: 'Traceback (most recent call last):\n  File "x"\n',
          },
        })}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('MODEL_LOAD_FAILED')).toBeInTheDocument();
    expect(screen.getByText(/Pywr could not load/)).toBeInTheDocument();

    // Traceback is hidden by default; clicking expands it.
    expect(screen.queryByText(/Traceback \(most recent/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/show traceback/));
    expect(screen.getByText(/Traceback \(most recent/)).toBeInTheDocument();
  });

  it('omits the traceback toggle when no traceback was supplied', () => {
    render(
      <RunPanel
        state={baseState({
          status: 'error',
          error: { code: 'PYTHON_MISSING', message: 'no python', traceback: '' },
        })}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.queryByText(/show traceback/)).not.toBeInTheDocument();
  });
});

describe('RunPanel — cancelled state', () => {
  it('shows a cancellation note with the output dir hint', () => {
    render(
      <RunPanel
        state={baseState({
          status: 'cancelled',
          outDir: '/tmp/m.results',
        })}
        onCancel={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    // "Run cancelled" appears in both the header and the body — assert at
    // least one occurrence rather than wrestling with disambiguation.
    expect(screen.getAllByText(/Run cancelled/).length).toBeGreaterThan(0);
    expect(screen.getByText(/\/tmp\/m\.results/)).toBeInTheDocument();
  });
});

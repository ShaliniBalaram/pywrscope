// src/test/useLayout.test.ts
// Unit tests for the useLayout hook — positions, undo/redo, dagre layout

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLayout } from '../hooks/useLayout';

// Tauri bridge mock (readLayoutFile / saveLayoutFile)
beforeEach(() => {
  Object.defineProperty(window, 'pywr', {
    value: {
      readLayoutFile: vi.fn().mockResolvedValue(null),
      saveLayoutFile: vi.fn().mockResolvedValue(undefined),
      openFile: vi.fn(),
      callApi: vi.fn(),
      saveFile: vi.fn(),
      openCsv: vi.fn(),
      readCsvColumns: vi.fn(),
      quit: vi.fn(),
      openImage: vi.fn(),
    },
    writable: true,
  });
});

describe('setPosition', () => {
  it('stores a position for a named node', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('NodeA', 100, 200); });
    expect(result.current.positions['NodeA']).toEqual({ x: 100, y: 200 });
  });

  it('overwrites an existing position', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('N', 10, 20); });
    act(() => { result.current.setPosition('N', 50, 60); });
    expect(result.current.positions['N']).toEqual({ x: 50, y: 60 });
  });

  it('stores multiple nodes independently', () => {
    const { result } = renderHook(() => useLayout());
    act(() => {
      result.current.setPosition('A', 0, 0);
      result.current.setPosition('B', 100, 100);
    });
    expect(result.current.positions['A']).toEqual({ x: 0, y: 0 });
    expect(result.current.positions['B']).toEqual({ x: 100, y: 100 });
  });
});

describe('setAllPositions', () => {
  it('replaces all positions at once', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('Old', 1, 2); });
    act(() => { result.current.setAllPositions({ New: { x: 99, y: 88 } }); });
    expect(result.current.positions).toEqual({ New: { x: 99, y: 88 } });
    expect(result.current.positions['Old']).toBeUndefined();
  });
});

describe('renamePosition', () => {
  it('renames a position entry', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('OldName', 10, 20); });
    act(() => { result.current.renamePosition('OldName', 'NewName'); });
    expect(result.current.positions['NewName']).toEqual({ x: 10, y: 20 });
    expect(result.current.positions['OldName']).toBeUndefined();
  });

  it('does nothing if the old name does not exist', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 1, 2); });
    act(() => { result.current.renamePosition('Ghost', 'B'); });
    expect(Object.keys(result.current.positions)).toEqual(['A']);
  });
});

describe('resetLayout', () => {
  it('clears all positions', () => {
    const { result } = renderHook(() => useLayout());
    act(() => {
      result.current.setPosition('A', 1, 2);
      result.current.setPosition('B', 3, 4);
    });
    act(() => { result.current.resetLayout(); });
    expect(result.current.positions).toEqual({});
  });

  it('clears position undo history', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 1, 2); });
    act(() => { result.current.pushPositionHistory(); });
    expect(result.current.canUndoPositions).toBe(true);
    act(() => { result.current.resetLayout(); });
    expect(result.current.canUndoPositions).toBe(false);
  });

  it('resets background opacity to 0.4', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setBackgroundOpacity(0.8); });
    act(() => { result.current.resetLayout(); });
    expect(result.current.backgroundOpacity).toBe(0.4);
  });
});

describe('backgroundImage and opacity', () => {
  it('sets background image path', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setBackgroundImage('/path/to/image.png'); });
    expect(result.current.backgroundImage).toBe('/path/to/image.png');
  });

  it('clamps opacity to 0.1–0.9', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setBackgroundOpacity(0.0); });
    expect(result.current.backgroundOpacity).toBe(0.1);
    act(() => { result.current.setBackgroundOpacity(1.0); });
    expect(result.current.backgroundOpacity).toBe(0.9);
    act(() => { result.current.setBackgroundOpacity(0.5); });
    expect(result.current.backgroundOpacity).toBe(0.5);
  });
});

describe('position undo/redo', () => {
  it('canUndoPositions is false initially', () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.canUndoPositions).toBe(false);
  });

  it('canUndoPositions is true after pushPositionHistory', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 10, 20); });
    act(() => { result.current.pushPositionHistory(); });
    expect(result.current.canUndoPositions).toBe(true);
  });

  it('undoPositions restores the previous position snapshot', () => {
    const { result } = renderHook(() => useLayout());
    // Set initial positions and snapshot
    act(() => { result.current.setPosition('A', 10, 20); });
    act(() => { result.current.pushPositionHistory(); }); // snapshot: {A: {10,20}}
    // Move node to new position
    act(() => { result.current.setPosition('A', 50, 60); });
    expect(result.current.positions['A']).toEqual({ x: 50, y: 60 });
    // Undo should restore to {10, 20}
    act(() => { result.current.undoPositions(); });
    expect(result.current.positions['A']).toEqual({ x: 10, y: 20 });
  });

  it('redoPositions re-applies the undone snapshot', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 10, 20); });
    act(() => { result.current.pushPositionHistory(); });
    act(() => { result.current.setPosition('A', 50, 60); });
    act(() => { result.current.undoPositions(); });
    expect(result.current.positions['A']).toEqual({ x: 10, y: 20 });
    act(() => { result.current.redoPositions(); });
    expect(result.current.positions['A']).toEqual({ x: 50, y: 60 });
  });

  it('canRedoPositions is false initially', () => {
    const { result } = renderHook(() => useLayout());
    expect(result.current.canRedoPositions).toBe(false);
  });

  it('canRedoPositions becomes true after undo', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 1, 2); });
    act(() => { result.current.pushPositionHistory(); });
    act(() => { result.current.setPosition('A', 9, 9); });
    act(() => { result.current.undoPositions(); });
    expect(result.current.canRedoPositions).toBe(true);
  });

  it('pushPositionHistory clears redo history', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 1, 2); });
    act(() => { result.current.pushPositionHistory(); });
    act(() => { result.current.setPosition('A', 5, 5); });
    act(() => { result.current.undoPositions(); });
    expect(result.current.canRedoPositions).toBe(true);
    // Push a new snapshot — redo should be cleared
    act(() => { result.current.pushPositionHistory(); });
    expect(result.current.canRedoPositions).toBe(false);
  });

  it('undoPositions on empty stack does nothing', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 10, 20); });
    expect(() => act(() => { result.current.undoPositions(); })).not.toThrow();
    expect(result.current.positions['A']).toEqual({ x: 10, y: 20 });
  });

  it('supports multiple undo steps', () => {
    const { result } = renderHook(() => useLayout());
    act(() => { result.current.setPosition('A', 0, 0); });
    act(() => { result.current.pushPositionHistory(); });
    act(() => { result.current.setPosition('A', 100, 100); });
    act(() => { result.current.pushPositionHistory(); });
    act(() => { result.current.setPosition('A', 200, 200); });

    act(() => { result.current.undoPositions(); });
    expect(result.current.positions['A']).toEqual({ x: 100, y: 100 });
    act(() => { result.current.undoPositions(); });
    expect(result.current.positions['A']).toEqual({ x: 0, y: 0 });
  });
});

describe('dagreLayout', () => {
  it('computes positions for all nodes', () => {
    const { result } = renderHook(() => useLayout());
    act(() => {
      result.current.dagreLayout(
        ['Source', 'Link', 'Demand'],
        [
          ['Source', 'Link'],
          ['Link', 'Demand'],
        ]
      );
    });
    expect(result.current.positions).toHaveProperty('Source');
    expect(result.current.positions).toHaveProperty('Link');
    expect(result.current.positions).toHaveProperty('Demand');
  });

  it('places nodes at numeric coordinates', () => {
    const { result } = renderHook(() => useLayout());
    act(() => {
      result.current.dagreLayout(['A', 'B'], [['A', 'B']]);
    });
    const a = result.current.positions['A'];
    expect(typeof a.x).toBe('number');
    expect(typeof a.y).toBe('number');
  });
});

describe('loadLayout', () => {
  it('returns false when no sidecar file exists', async () => {
    (window.pywr.readLayoutFile as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const { result } = renderHook(() => useLayout());
    let returned: boolean = false;
    await act(async () => {
      returned = await result.current.loadLayout('/some/model.json');
    });
    expect(returned).toBe(false);
  });

  it('loads positions from sidecar and returns true', async () => {
    const sidecar = JSON.stringify({
      version: 1,
      nodes: { A: { x: 10, y: 20 }, B: { x: 30, y: 40 } },
      backgroundImage: null,
      backgroundOpacity: 0.5,
    });
    (window.pywr.readLayoutFile as ReturnType<typeof vi.fn>).mockResolvedValue(sidecar);
    const { result } = renderHook(() => useLayout());
    let returned: boolean = false;
    await act(async () => {
      returned = await result.current.loadLayout('/some/model.json');
    });
    expect(returned).toBe(true);
    expect(result.current.positions['A']).toEqual({ x: 10, y: 20 });
    expect(result.current.positions['B']).toEqual({ x: 30, y: 40 });
    expect(result.current.backgroundOpacity).toBe(0.5);
  });

  it('returns false for corrupted sidecar JSON', async () => {
    (window.pywr.readLayoutFile as ReturnType<typeof vi.fn>).mockResolvedValue('{bad json}');
    const { result } = renderHook(() => useLayout());
    let returned: boolean = false;
    await act(async () => {
      returned = await result.current.loadLayout('/some/model.json');
    });
    expect(returned).toBe(false);
  });
});

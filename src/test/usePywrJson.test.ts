// src/test/usePywrJson.test.ts
// Unit tests for the usePywrJson hook — model mutations, undo/redo, history

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePywrJson } from '../hooks/usePywrJson';
import type { PywrModel } from '../types/pywr';

// Mock the Tauri window.pywr bridge — not available in jsdom
const mockOpenFile = vi.fn().mockResolvedValue(null);
const mockCallApi = vi.fn().mockResolvedValue({ ok: false });

beforeEach(() => {
  Object.defineProperty(window, 'pywr', {
    value: {
      openFile: mockOpenFile,
      callApi: mockCallApi,
      saveFile: vi.fn(),
      saveLayoutFile: vi.fn(),
      readLayoutFile: vi.fn(),
      openCsv: vi.fn(),
      readCsvColumns: vi.fn(),
      quit: vi.fn(),
      openImage: vi.fn(),
    },
    writable: true,
  });
});

function blankModel(): PywrModel {
  return {
    metadata: { title: 'Test', description: '', minimum_version: '1.0' },
    timestepper: { start: '2020-01-01', end: '2020-12-31', timestep: 1 },
    nodes: [],
    edges: [],
    parameters: {},
    recorders: {},
  };
}

describe('newModel', () => {
  it('starts with no model', () => {
    const { result } = renderHook(() => usePywrJson());
    expect(result.current.model).toBeNull();
  });

  it('creates a blank model with newModel()', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    expect(result.current.model).not.toBeNull();
    expect(result.current.model!.nodes).toHaveLength(0);
    expect(result.current.model!.edges).toHaveLength(0);
    expect(result.current.isDirty).toBe(false);
  });

  it('clears undo history on newModel()', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N1', type: 'Input' }); });
    expect(result.current.canUndo).toBe(true);
    act(() => { result.current.newModel(); });
    expect(result.current.canUndo).toBe(false);
    expect(result.current.canRedo).toBe(false);
  });
});

describe('addNode', () => {
  it('adds a node to the model', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Source1', type: 'Input' }); });
    expect(result.current.model!.nodes).toHaveLength(1);
    expect(result.current.model!.nodes[0].name).toBe('Source1');
    expect(result.current.isDirty).toBe(true);
  });

  it('pushes to undo history', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    expect(result.current.canUndo).toBe(false);
    act(() => { result.current.addNode({ name: 'N1', type: 'Input' }); });
    expect(result.current.canUndo).toBe(true);
  });

  it('adds multiple nodes independently', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Link' });
      result.current.addNode({ name: 'C', type: 'Output' });
    });
    expect(result.current.model!.nodes).toHaveLength(3);
  });
});

describe('removeNode', () => {
  it('removes a node by name', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'X', type: 'Link' }); });
    act(() => { result.current.removeNode('X'); });
    expect(result.current.model!.nodes).toHaveLength(0);
  });

  it('does not affect other nodes', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => { result.current.removeNode('A'); });
    expect(result.current.model!.nodes).toHaveLength(1);
    expect(result.current.model!.nodes[0].name).toBe('B');
  });

  // -------------------------------------------------------------------------
  // Cascade behaviour — removeNode is the SSOT for reference cleanup.
  // -------------------------------------------------------------------------
  describe('cascade', () => {
    it('removes all edges that touch the deleted node (in either direction)', () => {
      const { result } = renderHook(() => usePywrJson());
      act(() => {
        result.current.replaceModel({
          ...blankModel(),
          nodes: [
            { name: 'A', type: 'Input' },
            { name: 'B', type: 'Link' },
            { name: 'C', type: 'Output' },
          ],
          edges: [
            ['A', 'B'],
            ['B', 'C'],
            ['A', 'C'],
          ],
        });
      });
      act(() => { result.current.removeNode('B'); });
      expect(result.current.model!.edges).toEqual([['A', 'C']]);
    });

    it('removes recorders whose `node` field equals the deleted name', () => {
      const { result } = renderHook(() => usePywrJson());
      act(() => {
        result.current.replaceModel({
          ...blankModel(),
          nodes: [
            { name: 'Reservoir1', type: 'Storage', max_volume: 100 },
            { name: 'Reservoir2', type: 'Storage', max_volume: 200 },
          ],
          recorders: {
            r_one: { type: 'NumpyArrayNodeRecorder', node: 'Reservoir1' },
            r_two: { type: 'NumpyArrayNodeRecorder', node: 'Reservoir2' },
            r_param: { type: 'NumpyArrayParameterRecorder', param: 'p1' },
          },
        });
      });
      act(() => { result.current.removeNode('Reservoir1'); });
      expect(result.current.model!.recorders).toEqual({
        r_two: { type: 'NumpyArrayNodeRecorder', node: 'Reservoir2' },
        r_param: { type: 'NumpyArrayParameterRecorder', param: 'p1' },
      });
    });

    it('scrubs the deleted name from VirtualStorage `nodes` arrays', () => {
      const { result } = renderHook(() => usePywrJson());
      act(() => {
        result.current.replaceModel({
          ...blankModel(),
          nodes: [
            { name: 'A', type: 'Input' },
            { name: 'B', type: 'Output' },
            { name: 'VS', type: 'VirtualStorage', nodes: ['A', 'B'] },
          ],
        });
      });
      act(() => { result.current.removeNode('A'); });
      const vs = result.current.model!.nodes.find((n) => n.name === 'VS') as
        | { nodes?: string[] }
        | undefined;
      expect(vs?.nodes).toEqual(['B']);
    });

    it('leaves parameters untouched (D-06: parameters are opaque)', () => {
      const { result } = renderHook(() => usePywrJson());
      const params = {
        cost_param: { type: 'ConstantParameter', value: 10, node: 'A' },
      };
      act(() => {
        result.current.replaceModel({
          ...blankModel(),
          nodes: [{ name: 'A', type: 'Input' }],
          parameters: params,
        });
      });
      act(() => { result.current.removeNode('A'); });
      expect(result.current.model!.parameters).toEqual(params);
    });

    it('cascade is atomic — one undo restores everything together', () => {
      const { result } = renderHook(() => usePywrJson());
      const initial = {
        ...blankModel(),
        nodes: [
          { name: 'A', type: 'Input' as const },
          { name: 'B', type: 'Output' as const },
          { name: 'VS', type: 'VirtualStorage' as const, nodes: ['A', 'B'] },
        ],
        edges: [['A', 'B'] as const],
        recorders: {
          r1: { type: 'NumpyArrayNodeRecorder', node: 'A' },
        },
      };
      act(() => { result.current.replaceModel(initial); });
      act(() => { result.current.removeNode('A'); });

      // Sanity: cascade fired
      expect(result.current.model!.nodes.find((n) => n.name === 'A')).toBeUndefined();
      expect(result.current.model!.edges).toEqual([]);
      expect(result.current.model!.recorders).toEqual({});

      // One undo restores all of it atomically
      act(() => { result.current.undo(); });
      expect(result.current.model!.nodes).toHaveLength(3);
      expect(result.current.model!.edges).toEqual([['A', 'B']]);
      expect(result.current.model!.recorders).toEqual({
        r1: { type: 'NumpyArrayNodeRecorder', node: 'A' },
      });
      const vs = result.current.model!.nodes.find((n) => n.name === 'VS') as
        | { nodes?: string[] }
        | undefined;
      expect(vs?.nodes).toEqual(['A', 'B']);
    });
  });
});

describe('updateNodePosition / updateNodePositions', () => {
  it('writes position.editor_position and position.schematic onto the named node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.updateNodePosition('A', 100, 200); });
    const node = result.current.model!.nodes[0] as unknown as {
      position?: { editor_position?: [number, number]; schematic?: [number, number] };
    };
    expect(node.position?.editor_position).toEqual([100, 200]);
    expect(node.position?.schematic).toEqual([100, 200]);
  });

  it('updateNodePositions writes multiple nodes in one model update', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => {
      result.current.updateNodePositions({ A: { x: 1, y: 2 }, B: { x: 3, y: 4 } });
    });
    const a = result.current.model!.nodes[0] as unknown as { position?: { editor_position?: [number, number] } };
    const b = result.current.model!.nodes[1] as unknown as { position?: { editor_position?: [number, number] } };
    expect(a.position?.editor_position).toEqual([1, 2]);
    expect(b.position?.editor_position).toEqual([3, 4]);
  });

  it('returns the same model reference when positions are unchanged (breaks the layout↔model sync loop)', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.updateNodePosition('A', 5, 6); });
    const before = result.current.model;
    act(() => { result.current.updateNodePosition('A', 5, 6); }); // same coords
    expect(result.current.model).toBe(before);
  });

  it('preserves existing position keys (geographic) when updating editor_position', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      // Inject a node that already has geographic coords (as if loaded from disk)
      result.current.replaceModel({
        ...blankModel(),
        nodes: [
          {
            name: 'A',
            type: 'Input',
            // @ts-expect-error — position is off-schema on PywrNode types
            position: { geographic: [-1.5, 53.2] },
          },
        ],
      });
    });
    act(() => { result.current.updateNodePosition('A', 50, 60); });
    const a = result.current.model!.nodes[0] as unknown as {
      position?: { geographic?: [number, number]; editor_position?: [number, number] };
    };
    expect(a.position?.geographic).toEqual([-1.5, 53.2]);
    expect(a.position?.editor_position).toEqual([50, 60]);
  });

  it('skips nodes with non-finite coordinates (defensive)', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.updateNodePosition('A', NaN, 10); });
    const node = result.current.model!.nodes[0] as unknown as { position?: unknown };
    expect(node.position).toBeUndefined();
  });

  it('does NOT push to history (positions are tracked separately by useLayout)', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    const historyLengthBefore = result.current.historyLog.length;
    act(() => { result.current.updateNodePosition('A', 100, 100); });
    expect(result.current.historyLog.length).toBe(historyLengthBefore);
  });

  it('marks the model dirty when a position actually changes', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.markSaved(); });
    expect(result.current.isDirty).toBe(false);
    act(() => { result.current.updateNodePosition('A', 7, 8); });
    expect(result.current.isDirty).toBe(true);
  });
});

describe('updateNode', () => {
  it('merges partial updates into the node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N', type: 'Input' }); });
    act(() => { result.current.updateNode('N', { max_flow: 100 } as never); });
    const node = result.current.model!.nodes[0] as { max_flow?: number };
    expect(node.max_flow).toBe(100);
  });

  it('does not mutate other nodes', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Link' });
    });
    act(() => { result.current.updateNode('A', { cost: 5 } as never); });
    expect(result.current.model!.nodes[1].name).toBe('B');
    expect((result.current.model!.nodes[1] as { cost?: number }).cost).toBeUndefined();
  });
});

describe('renameNode', () => {
  it('renames a node and updates edge references', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'Old', type: 'Input' });
      result.current.addNode({ name: 'Target', type: 'Output' });
    });
    act(() => { result.current.addEdge('Old', 'Target'); });
    act(() => { result.current.renameNode('Old', 'New'); });
    expect(result.current.model!.nodes[0].name).toBe('New');
    expect(result.current.model!.edges[0][0]).toBe('New');
  });

  it('ignores empty new name', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Node', type: 'Link' }); });
    act(() => { result.current.renameNode('Node', ''); });
    expect(result.current.model!.nodes[0].name).toBe('Node');
  });

  it('ignores rename to same name', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Node', type: 'Link' }); });
    const before = result.current.historyLog.length;
    act(() => { result.current.renameNode('Node', 'Node'); });
    expect(result.current.historyLog.length).toBe(before);
  });
});

describe('addEdge / removeEdge', () => {
  it('adds an edge between two nodes', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => { result.current.addEdge('A', 'B'); });
    expect(result.current.model!.edges).toHaveLength(1);
    expect(result.current.model!.edges[0]).toEqual(['A', 'B']);
  });

  it('removes an edge', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => { result.current.addEdge('A', 'B'); });
    act(() => { result.current.removeEdge('A', 'B'); });
    expect(result.current.model!.edges).toHaveLength(0);
  });

  it('only removes the first matching edge when duplicates exist', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => {
      result.current.addEdge('A', 'B');
      result.current.addEdge('A', 'B');
    });
    act(() => { result.current.removeEdge('A', 'B'); });
    expect(result.current.model!.edges).toHaveLength(1);
  });
});

describe('undo / redo', () => {
  it('undo restores previous model state', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N', type: 'Input' }); });
    expect(result.current.model!.nodes).toHaveLength(1);
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(0);
  });

  it('redo re-applies undone action', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N', type: 'Input' }); });
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(0);
    act(() => { result.current.redo(); });
    expect(result.current.model!.nodes).toHaveLength(1);
  });

  it('canUndo is false initially', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    expect(result.current.canUndo).toBe(false);
  });

  it('canRedo is false initially', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    expect(result.current.canRedo).toBe(false);
  });

  it('redo is cleared when a new action is taken after undo', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.undo(); });
    expect(result.current.canRedo).toBe(true);
    act(() => { result.current.addNode({ name: 'B', type: 'Link' }); });
    expect(result.current.canRedo).toBe(false);
  });

  it('supports multiple sequential undos', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'A', type: 'Input' }); });
    act(() => { result.current.addNode({ name: 'B', type: 'Output' }); });
    act(() => { result.current.addNode({ name: 'C', type: 'Link' }); });
    expect(result.current.model!.nodes).toHaveLength(3);
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(2);
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(1);
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(0);
  });

  it('undo of removeNode restores the node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'X', type: 'Storage', max_volume: 0 }); });
    act(() => { result.current.removeNode('X'); });
    expect(result.current.model!.nodes).toHaveLength(0);
    act(() => { result.current.undo(); });
    expect(result.current.model!.nodes).toHaveLength(1);
    expect(result.current.model!.nodes[0].name).toBe('X');
  });

  it('undo of addEdge removes the edge', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Output' });
    });
    act(() => { result.current.addEdge('A', 'B'); });
    act(() => { result.current.undo(); });
    expect(result.current.model!.edges).toHaveLength(0);
  });
});

describe('getNodeByName', () => {
  it('finds an existing node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Found', type: 'Link' }); });
    const node = result.current.getNodeByName('Found');
    expect(node).toBeDefined();
    expect(node!.name).toBe('Found');
  });

  it('returns undefined for missing node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    expect(result.current.getNodeByName('Ghost')).toBeUndefined();
  });
});

describe('getEdgesForNode', () => {
  it('returns all edges connected to the node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Link' });
      result.current.addNode({ name: 'C', type: 'Output' });
    });
    act(() => {
      result.current.addEdge('A', 'B');
      result.current.addEdge('B', 'C');
    });
    const edges = result.current.getEdgesForNode('B');
    expect(edges).toHaveLength(2);
  });

  it('returns empty array for unconnected node', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Lone', type: 'Storage', max_volume: 0 }); });
    expect(result.current.getEdgesForNode('Lone')).toHaveLength(0);
  });
});

describe('getOrphanedNodes', () => {
  it('identifies downstream nodes that lose their only upstream connection', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addNode({ name: 'A', type: 'Input' });
      result.current.addNode({ name: 'B', type: 'Link' });
      result.current.addNode({ name: 'C', type: 'Output' });
    });
    act(() => {
      result.current.addEdge('A', 'B');
      result.current.addEdge('B', 'C');
    });
    // Removing B should flag C as orphaned downstream (loses its only source)
    const { downstream } = result.current.getOrphanedNodes('B');
    expect(downstream).toContain('C');
  });

  it('returns empty lists for isolated node removal', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'Lone', type: 'Storage', max_volume: 0 }); });
    const { upstream, downstream } = result.current.getOrphanedNodes('Lone');
    expect(upstream).toHaveLength(0);
    expect(downstream).toHaveLength(0);
  });
});

describe('addParameter / removeParameter', () => {
  it('adds a parameter to the model', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addParameter('flow_param', { type: 'ConstantParameter', value: 10 });
    });
    expect(result.current.model!.parameters).toHaveProperty('flow_param');
  });

  it('removes a parameter', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => {
      result.current.addParameter('p', { type: 'ConstantParameter', value: 5 });
    });
    act(() => { result.current.removeParameter('p'); });
    expect(result.current.model!.parameters).not.toHaveProperty('p');
  });
});

describe('onPushHistory / onClearHistory callbacks', () => {
  it('calls onPushHistory when a model action is performed', () => {
    const onPushHistory = vi.fn();
    const { result } = renderHook(() => usePywrJson({ onPushHistory }));
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N', type: 'Input' }); });
    expect(onPushHistory).toHaveBeenCalledTimes(1);
  });

  it('calls onClearHistory on newModel()', () => {
    const onClearHistory = vi.fn();
    const { result } = renderHook(() => usePywrJson({ onClearHistory }));
    act(() => { result.current.newModel(); });
    expect(onClearHistory).toHaveBeenCalledTimes(1);
  });
});

describe('historyLog', () => {
  it('records actions in order (newest first)', () => {
    const { result } = renderHook(() => usePywrJson());
    act(() => { result.current.newModel(); });
    act(() => { result.current.addNode({ name: 'N1', type: 'Input' }); });
    act(() => { result.current.addNode({ name: 'N2', type: 'Output' }); });
    expect(result.current.historyLog[0].label).toContain('N2');
    expect(result.current.historyLog[1].label).toContain('N1');
  });
});

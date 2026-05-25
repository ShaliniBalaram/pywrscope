// src/test/dagreLayout.test.ts
// Tests for the dagre layout utility

import { describe, it, expect } from 'vitest';
import { computeDagreLayout, computePywrModelLayout } from '../utils/dagreLayout';

describe('computeDagreLayout', () => {
  it('returns empty object for empty input', () => {
    const result = computeDagreLayout([], []);
    expect(result).toEqual({});
  });

  it('returns a position for a single node', () => {
    const result = computeDagreLayout(['A'], []);
    expect(result).toHaveProperty('A');
    expect(typeof result['A'].x).toBe('number');
    expect(typeof result['A'].y).toBe('number');
  });

  it('returns positions for all named nodes', () => {
    const nodes = ['Input1', 'Link1', 'Output1'];
    const edges = [
      ['Input1', 'Link1'] as const,
      ['Link1', 'Output1'] as const,
    ];
    const result = computeDagreLayout(nodes, edges);
    expect(Object.keys(result)).toHaveLength(3);
    expect(result).toHaveProperty('Input1');
    expect(result).toHaveProperty('Link1');
    expect(result).toHaveProperty('Output1');
  });

  it('places upstream nodes to the left of downstream nodes (LR layout)', () => {
    const nodes = ['Source', 'Sink'];
    const edges = [['Source', 'Sink'] as const];
    const result = computeDagreLayout(nodes, edges);
    // In LR layout, source should have lower x than sink
    expect(result['Source'].x).toBeLessThan(result['Sink'].x);
  });

  it('ignores edges referencing nodes not in the list', () => {
    const nodes = ['A', 'B'];
    const edges = [
      ['A', 'B'] as const,
      ['A', 'GHOST'] as const, // not in node list
    ];
    expect(() => computeDagreLayout(nodes, edges)).not.toThrow();
    const result = computeDagreLayout(nodes, edges);
    expect(result).toHaveProperty('A');
    expect(result).toHaveProperty('B');
  });

  it('returns integer coordinates (rounded)', () => {
    const nodes = ['X', 'Y', 'Z'];
    const edges = [
      ['X', 'Y'] as const,
      ['Y', 'Z'] as const,
    ];
    const result = computeDagreLayout(nodes, edges);
    for (const pos of Object.values(result)) {
      expect(pos.x).toBe(Math.round(pos.x));
      expect(pos.y).toBe(Math.round(pos.y));
    }
  });

  it('handles a branching network (1 input, 2 outputs)', () => {
    const nodes = ['In', 'Split', 'Out1', 'Out2'];
    const edges = [
      ['In', 'Split'] as const,
      ['Split', 'Out1'] as const,
      ['Split', 'Out2'] as const,
    ];
    const result = computeDagreLayout(nodes, edges);
    expect(Object.keys(result)).toHaveLength(4);
    // Both outputs should be to the right of the split
    expect(result['Out1'].x).toBeGreaterThan(result['Split'].x);
    expect(result['Out2'].x).toBeGreaterThan(result['Split'].x);
  });

  it('handles disconnected nodes (no edges)', () => {
    const nodes = ['A', 'B', 'C'];
    const result = computeDagreLayout(nodes, []);
    expect(Object.keys(result)).toHaveLength(3);
  });

  it('handles a large network (50 nodes) without errors', () => {
    const nodes = Array.from({ length: 50 }, (_, i) => `Node${i}`);
    const edges = nodes.slice(1).map((n, i) => [nodes[i], n] as const);
    expect(() => computeDagreLayout(nodes, edges)).not.toThrow();
    const result = computeDagreLayout(nodes, edges);
    expect(Object.keys(result)).toHaveLength(50);
  });
});

describe('computePywrModelLayout', () => {
  it('places disconnected reference nodes near the nodes they aggregate', () => {
    const result = computePywrModelLayout({
      metadata: {},
      timestepper: { start: '2026-01-01', end: '2026-01-02', timestep: 1 },
      nodes: [
        { name: 'GW_A', type: 'Input' },
        { name: 'WTW_A', type: 'Link' },
        { name: 'DC_A', type: 'Output' },
        { name: 'Virtual_GW_group', type: 'AggregatedNode', nodes: ['GW_A', 'WTW_A'] },
      ],
      edges: [
        ['GW_A', 'WTW_A'],
        ['WTW_A', 'DC_A'],
      ],
      parameters: {},
      recorders: {},
    });

    const refMidX = (result.GW_A.x + result.WTW_A.x) / 2;
    const refMidY = (result.GW_A.y + result.WTW_A.y) / 2;
    expect(Math.abs(result.Virtual_GW_group.x - refMidX)).toBeLessThan(140);
    expect(Math.abs(result.Virtual_GW_group.y - refMidY)).toBeLessThan(140);
  });
});

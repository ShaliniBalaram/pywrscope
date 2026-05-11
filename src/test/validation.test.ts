// src/test/validation.test.ts
// Tests for the ValidationBar fingerprint logic (the TS-side validation utility)
// The actual Rust validation is tested separately in src-tauri/src/lib.rs tests.

import { describe, it, expect } from 'vitest';
import type { PywrModel } from '../types/pywr';

// Re-implement the fingerprint logic extracted from ValidationBar.tsx for testing
function modelFingerprint(model: PywrModel | null): string | null {
  if (!model) return null;
  const nodeKey = model.nodes.map(n => `${n.name}:${n.type}`).join(',');
  const edgeKey = model.edges.map(e => `${e[0]}->${e[1]}`).join(',');
  return `${model.nodes.length}|${model.edges.length}|${nodeKey}|${edgeKey}`;
}

function baseModel(): PywrModel {
  return {
    nodes: [],
    edges: [],
    parameters: {},
    recorders: {},
    timestepper: { start: '2020-01-01', end: '2020-12-31', timestep: 1 },
  };
}

describe('modelFingerprint', () => {
  it('returns null for null model', () => {
    expect(modelFingerprint(null)).toBeNull();
  });

  it('returns a string for empty model', () => {
    const fp = modelFingerprint(baseModel());
    expect(typeof fp).toBe('string');
  });

  it('changes when a node is added', () => {
    const m1 = baseModel();
    const fp1 = modelFingerprint(m1);
    const m2 = { ...m1, nodes: [{ name: 'A', type: 'Input' as const }] };
    expect(modelFingerprint(m2)).not.toBe(fp1);
  });

  it('changes when an edge is added', () => {
    const m = {
      ...baseModel(),
      nodes: [
        { name: 'A', type: 'Input' as const },
        { name: 'B', type: 'Output' as const },
      ],
    };
    const fp1 = modelFingerprint(m);
    const m2 = { ...m, edges: [['A', 'B'] as const] };
    expect(modelFingerprint(m2)).not.toBe(fp1);
  });

  it('does NOT change when only parameters change (fingerprint ignores parameters)', () => {
    const m1 = {
      ...baseModel(),
      nodes: [{ name: 'A', type: 'Input' as const }],
      parameters: {},
    };
    const fp1 = modelFingerprint(m1);
    const m2 = { ...m1, parameters: { some_param: { type: 'ConstantParameter', value: 5 } } };
    // fingerprint only hashes nodes/edges, not parameters
    expect(modelFingerprint(m2)).toBe(fp1);
  });

  it('does NOT change when only recorders change', () => {
    const m = { ...baseModel(), nodes: [{ name: 'A', type: 'Input' as const }] };
    const fp1 = modelFingerprint(m);
    const m2 = { ...m, recorders: { rec: { type: 'NumpyArrayNodeRecorder', node: 'A' } } };
    expect(modelFingerprint(m2)).toBe(fp1);
  });

  it('changes when a node is renamed', () => {
    const m1 = { ...baseModel(), nodes: [{ name: 'A', type: 'Input' as const }] };
    const m2 = { ...baseModel(), nodes: [{ name: 'B', type: 'Input' as const }] };
    expect(modelFingerprint(m1)).not.toBe(modelFingerprint(m2));
  });

  it('produces the same fingerprint for identical models', () => {
    const m1 = {
      ...baseModel(),
      nodes: [{ name: 'A', type: 'Input' as const }],
      edges: [['A', 'A'] as const],
    };
    const m2 = structuredClone(m1);
    expect(modelFingerprint(m1)).toBe(modelFingerprint(m2));
  });

  it('includes node count in fingerprint to detect additions', () => {
    const m1 = { ...baseModel(), nodes: [{ name: 'A', type: 'Input' as const }] };
    const m2 = {
      ...baseModel(),
      nodes: [
        { name: 'A', type: 'Input' as const },
        { name: 'B', type: 'Output' as const },
      ],
    };
    const fp1 = modelFingerprint(m1)!;
    const fp2 = modelFingerprint(m2)!;
    expect(fp1.split('|')[0]).toBe('1');
    expect(fp2.split('|')[0]).toBe('2');
  });
});

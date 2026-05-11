// src/test/nodeTypes.test.ts
// Tests for node type constants and normalisation

import { describe, it, expect } from 'vitest';
import {
  NODE_COLOUR_MAP,
  NODE_SHAPE_MAP,
  NODE_DISPLAY_LABELS,
  NODE_DEFAULT_FIELDS,
  NODE_TYPES,
  normalizeNodeType,
} from '../constants/nodeTypes';

describe('NODE_COLOUR_MAP', () => {
  it('has an entry for every node type in NODE_TYPES', () => {
    for (const t of NODE_TYPES) {
      expect(NODE_COLOUR_MAP).toHaveProperty(t);
    }
  });

  it('all colour values are valid hex strings', () => {
    for (const [type, colour] of Object.entries(NODE_COLOUR_MAP)) {
      expect(colour, `colour for ${type}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
    }
  });

  it('contains the core Pywr node types', () => {
    const coreTypes = ['Input', 'Output', 'Link', 'Storage', 'Catchment', 'River'];
    for (const t of coreTypes) {
      expect(NODE_COLOUR_MAP).toHaveProperty(t);
    }
  });
});

describe('NODE_SHAPE_MAP', () => {
  const VALID_SHAPES = ['diamond', 'rectangle', 'circle', 'hexagon'];
  const VALID_BORDERS = ['solid', 'dashed', 'thick'];

  it('has an entry for every node type', () => {
    for (const t of NODE_TYPES) {
      expect(NODE_SHAPE_MAP).toHaveProperty(t);
    }
  });

  it('all shape values are valid', () => {
    for (const [type, s] of Object.entries(NODE_SHAPE_MAP)) {
      expect(VALID_SHAPES, `shape for ${type}`).toContain(s.shape);
      expect(VALID_BORDERS, `border for ${type}`).toContain(s.border);
    }
  });

  it('Input is diamond', () => {
    expect(NODE_SHAPE_MAP['Input'].shape).toBe('diamond');
  });

  it('Storage is circle', () => {
    expect(NODE_SHAPE_MAP['Storage'].shape).toBe('circle');
  });

  it('Link is rectangle', () => {
    expect(NODE_SHAPE_MAP['Link'].shape).toBe('rectangle');
  });
});

describe('NODE_DISPLAY_LABELS', () => {
  it('has a display label for every node type', () => {
    for (const t of NODE_TYPES) {
      expect(NODE_DISPLAY_LABELS).toHaveProperty(t);
      expect(NODE_DISPLAY_LABELS[t].length).toBeGreaterThan(0);
    }
  });
});

describe('NODE_DEFAULT_FIELDS', () => {
  it('has default fields for every node type', () => {
    for (const t of NODE_TYPES) {
      expect(NODE_DEFAULT_FIELDS).toHaveProperty(t);
    }
  });

  it('default fields include the correct type string', () => {
    for (const [key, fields] of Object.entries(NODE_DEFAULT_FIELDS)) {
      expect((fields as { type: string }).type).toBe(key);
    }
  });

  it('Storage defaults include max_volume', () => {
    expect(NODE_DEFAULT_FIELDS['Storage']).toHaveProperty('max_volume');
  });

  it('PiecewiseLink defaults include nsteps', () => {
    expect(NODE_DEFAULT_FIELDS['PiecewiseLink']).toHaveProperty('nsteps');
  });

  it('AggregatedNode defaults include nodes array', () => {
    expect(NODE_DEFAULT_FIELDS['AggregatedNode']).toHaveProperty('nodes');
  });
});

describe('normalizeNodeType', () => {
  it('returns PascalCase for lowercase input', () => {
    expect(normalizeNodeType('input')).toBe('Input');
    expect(normalizeNodeType('output')).toBe('Output');
    expect(normalizeNodeType('storage')).toBe('Storage');
    expect(normalizeNodeType('losslink')).toBe('LossLink');
    expect(normalizeNodeType('riversplitwithgauge')).toBe('RiverSplitWithGauge');
  });

  it('returns same string for already-correct PascalCase', () => {
    expect(normalizeNodeType('Input')).toBe('Input');
    expect(normalizeNodeType('RiverGauge')).toBe('RiverGauge');
    expect(normalizeNodeType('AnnualVirtualStorage')).toBe('AnnualVirtualStorage');
  });

  it('handles UPPERCASE input', () => {
    expect(normalizeNodeType('INPUT')).toBe('Input');
    expect(normalizeNodeType('LINK')).toBe('Link');
  });

  it('returns original string for unknown types', () => {
    expect(normalizeNodeType('UnknownType')).toBe('UnknownType');
    expect(normalizeNodeType('notanode')).toBe('notanode');
  });

  it('handles mixed-case variants', () => {
    expect(normalizeNodeType('annualvirtualstorage')).toBe('AnnualVirtualStorage');
    expect(normalizeNodeType('RESERVOIR')).toBe('Reservoir');
  });
});

describe('NODE_TYPES list', () => {
  it('is non-empty', () => {
    expect(NODE_TYPES.length).toBeGreaterThan(0);
  });

  it('contains no duplicates', () => {
    const set = new Set(NODE_TYPES);
    expect(set.size).toBe(NODE_TYPES.length);
  });

  it('contains all major Pywr categories', () => {
    const required = ['Input', 'Output', 'Link', 'Storage', 'River', 'Catchment'];
    for (const t of required) {
      expect(NODE_TYPES).toContain(t);
    }
  });
});

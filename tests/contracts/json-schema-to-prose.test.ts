import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { zodToJsonSchemaMini } from '../../src/agents/zod-to-jsonschema-mini.js';
import { jsonSchemaToProse } from '../../src/contracts/json-schema-to-prose.js';

describe('jsonSchemaToProse', () => {
  it('renders object with required and optional fields', () => {
    const schema = z.object({
      a: z.string(),
      b: z.number().optional(),
    }).strict();
    const prose = jsonSchemaToProse(zodToJsonSchemaMini(schema));
    expect(prose).toContain('object with fields:');
    expect(prose).toContain('- a (required): string');
    expect(prose).toContain('- b (optional): number');
  });

  it('renders enum strings inline', () => {
    const schema = z.object({ s: z.enum(['x', 'y']) });
    const prose = jsonSchemaToProse(zodToJsonSchemaMini(schema));
    expect(prose).toContain('s (required): string (one of: "x", "y")');
  });

  it('renders arrays of primitives', () => {
    const schema = z.object({ xs: z.array(z.string()) });
    const prose = jsonSchemaToProse(zodToJsonSchemaMini(schema));
    expect(prose).toContain('xs (required): array of string');
  });

  it('renders anyOf as a union', () => {
    const schema = z.object({ v: z.union([z.string(), z.number()]) });
    const prose = jsonSchemaToProse(zodToJsonSchemaMini(schema));
    expect(prose).toMatch(/v \(required\): one of:.*string.*\|.*number/);
  });
});

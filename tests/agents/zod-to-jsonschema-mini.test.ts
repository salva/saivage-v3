import { describe, it, expect } from '@jest/globals';
import { z } from 'zod';
import { zodToJsonSchemaMini } from '../../src/agents/zod-to-jsonschema-mini.js';
import {
  PlannerResultSchema,
  ExecutorResultSchema,
  ReviewerResultSchema,
} from '../../src/agents/role-envelope-schemas.js';

describe('zodToJsonSchemaMini — permissive nodes', () => {
  it('ZodUnknown emits the empty schema {}', () => {
    expect(zodToJsonSchemaMini(z.unknown())).toEqual({});
  });

  it('ZodRecord<ZodString, ZodUnknown> emits object with additionalProperties: {}', () => {
    const schema = zodToJsonSchemaMini(z.record(z.string(), z.unknown()));
    expect(schema).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('throws on unsupported nodes', () => {
    const bigint = z.bigint();
    expect(() => zodToJsonSchemaMini(bigint)).toThrow(/unsupported Zod node/);
  });
});

describe('zodToJsonSchemaMini — role schemas', () => {
  it('planner schema is a strict object (additionalProperties: false)', () => {
    const schema = zodToJsonSchemaMini(PlannerResultSchema) as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
  });

  it('executor schema is non-strict (additionalProperties: true)', () => {
    const schema = zodToJsonSchemaMini(ExecutorResultSchema) as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(true);
  });

  it('executor.result is record-of-unknown ⇒ object with additionalProperties: {}', () => {
    const schema = zodToJsonSchemaMini(ExecutorResultSchema) as { properties: Record<string, unknown> };
    expect(schema.properties.result).toEqual({ type: 'object', additionalProperties: {} });
  });

  it('executor.result is optional ⇒ not in required', () => {
    const schema = zodToJsonSchemaMini(ExecutorResultSchema) as { required?: string[] };
    expect(schema.required ?? []).not.toContain('result');
  });

  it('reviewer schema is a strict object (additionalProperties: false)', () => {
    const schema = zodToJsonSchemaMini(ReviewerResultSchema) as { additionalProperties: boolean };
    expect(schema.additionalProperties).toBe(false);
  });

  it('snapshot: planner schema', () => {
    expect(zodToJsonSchemaMini(PlannerResultSchema)).toMatchSnapshot();
  });

  it('snapshot: executor schema', () => {
    expect(zodToJsonSchemaMini(ExecutorResultSchema)).toMatchSnapshot();
  });

  it('snapshot: reviewer schema', () => {
    expect(zodToJsonSchemaMini(ReviewerResultSchema)).toMatchSnapshot();
  });
});

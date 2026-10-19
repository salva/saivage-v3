import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { zodToJsonSchemaMini } from '../../src/contracts/zod-json-schema.js';

describe('zodToJsonSchemaMini string constraints', () => {
  it('preserves minimum, maximum, pattern and description together', () => {
    expect(
      zodToJsonSchemaMini(
        z
          .string()
          .min(2)
          .max(8)
          .regex(/^[a-z]+$/)
          .describe('bounded'),
      ),
    ).toEqual({
      type: 'string',
      minLength: 2,
      maxLength: 8,
      pattern: '^[a-z]+$',
      description: 'bounded',
    });
  });

  it('retains a maximum of zero without inventing a minimum', () => {
    expect(zodToJsonSchemaMini(z.string().max(0))).toEqual({ type: 'string', maxLength: 0 });
  });

  it('leaves unbounded strings unbounded', () => {
    expect(zodToJsonSchemaMini(z.string())).toEqual({ type: 'string' });
  });

  it('preserves a bounded nullable string and its outer description', () => {
    expect(
      zodToJsonSchemaMini(z.string().min(1).max(4).nullable().describe('optional value')),
    ).toEqual({
      anyOf: [{ type: 'string', minLength: 1, maxLength: 4 }, { type: 'null' }],
      description: 'optional value',
    });
  });

  it('leaves enum values unchanged', () => {
    expect(zodToJsonSchemaMini(z.enum(['done', 'blocked']).describe('outcome'))).toEqual({
      type: 'string',
      enum: ['done', 'blocked'],
      description: 'outcome',
    });
  });
});

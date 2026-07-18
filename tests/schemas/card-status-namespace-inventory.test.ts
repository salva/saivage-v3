import { readFileSync } from 'node:fs';
import { describe, expect, it } from '@jest/globals';

import { processStatusSchema, reviewStatusSchema, runtimeStatusSchema, sessionStatusSchema } from '../../src/schemas/index.js';

describe('card status namespace inventory', () => {
  it('does not add a card status catalog to the CLI', () => {
    const cli = readFileSync(new URL('../../src/cli.ts', import.meta.url), 'utf8');
    expect(cli).not.toMatch(/\b(?:cardStatusValues|cardStatusSchema|CardStatus)\b/);
  });

  it('leaves unrelated status namespaces exact', () => {
    expect(processStatusSchema.options).toEqual(['running', 'exited', 'failed', 'killed']);
    expect(sessionStatusSchema.options).toEqual(['active', 'waiting', 'inactive']);
    expect(reviewStatusSchema.options).toEqual(['passed', 'blocked', 'sanitized']);
    expect(runtimeStatusSchema.options).toEqual(['stopped', 'starting', 'running', 'pausing', 'paused', 'closing', 'error']);
  });
});

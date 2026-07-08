import { describe, expect, it } from '@jest/globals';
import { saivageConfigSchema } from '../../src/agents/config-api.js';

describe('prompts config schema', () => {
  it('allows omitted prompts', () => {
    expect(saivageConfigSchema.safeParse({ models: { default: ['model'] } }).success).toBe(true);
  });

  it('accepts per-role string overrides', () => {
    const parsed = saivageConfigSchema.safeParse({
      models: { default: ['model'] },
      prompts: { planner: 'Plan {{cardId}}', executor: 'Execute', reviewer: 'Review', analyst: 'Analyze' },
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects unknown prompt role keys', () => {
    const parsed = saivageConfigSchema.safeParse({ models: { default: ['model'] }, prompts: { planer: 'typo' } });
    expect(parsed.success).toBe(false);
  });

  it('rejects empty prompt strings', () => {
    const parsed = saivageConfigSchema.safeParse({ models: { default: ['model'] }, prompts: { planner: '' } });
    expect(parsed.success).toBe(false);
  });
});

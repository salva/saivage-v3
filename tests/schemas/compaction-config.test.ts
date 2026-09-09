import { describe, expect, it } from '@jest/globals';

import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';

describe('compaction configuration', () => {
  it('defaults the singular tail fraction', () => {
    const current = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    delete compactionOf(current).tail_fraction;
    expect(saivageConfigSchema.parse(current).compaction.tail_fraction).toBe(0.25);
  });

  it('requires tail at or below trigger and a 2000-token completion reserve', () => {
    const tail = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    compactionOf(tail).tail_fraction = Number(compactionOf(tail).trigger_fraction) + 0.01;
    expect(() => saivageConfigSchema.parse(tail)).toThrow(/tail_fraction must be <= trigger_fraction/u);

    const reserve = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    compactionOf(reserve).input_budget_tokens = 9_999;
    compactionOf(reserve).completion_reserve_fraction = 0.2;
    expect(() => saivageConfigSchema.parse(reserve)).toThrow(/at least 2000/u);
  });
});

function compactionOf(config: unknown): Record<string, unknown> {
  return (config as { compaction: Record<string, unknown> }).compaction;
}

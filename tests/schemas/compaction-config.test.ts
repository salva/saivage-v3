import { describe, expect, it } from '@jest/globals';

import { DEFAULT_SAIVAGE_CONFIG } from '../../src/config/system-templates/registry.js';
import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';

describe('compaction configuration', () => {
  it('defaults the singular utilization, trigger, and tail fractions', () => {
    const current = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    delete compactionOf(current).context_utilization_fraction;
    delete compactionOf(current).trigger_fraction;
    delete compactionOf(current).tail_fraction;
    expect(saivageConfigSchema.parse(current).compaction).toMatchObject({ context_utilization_fraction: 0.8, trigger_fraction: 0.9, tail_fraction: 0.25 });
  });

  it('requires bounded fractions, tail at or below trigger, and rejects removed keys', () => {
    const tail = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    compactionOf(tail).tail_fraction = Number(compactionOf(tail).trigger_fraction) + 0.01;
    expect(() => saivageConfigSchema.parse(tail)).toThrow(/tail_fraction must be <= trigger_fraction/u);

    for (const value of [0, -0.1, 1.1, Number.POSITIVE_INFINITY]) {
      const invalid = structuredClone(DEFAULT_SAIVAGE_CONFIG);
      compactionOf(invalid).context_utilization_fraction = value;
      expect(() => saivageConfigSchema.parse(invalid)).toThrow();
    }
    const obsolete = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    compactionOf(obsolete).input_budget_tokens = 32_768;
    expect(() => saivageConfigSchema.parse(obsolete)).toThrow(/input_budget_tokens/u);
    const obsoleteReserve = structuredClone(DEFAULT_SAIVAGE_CONFIG);
    compactionOf(obsoleteReserve).completion_reserve_fraction = 0.2;
    expect(() => saivageConfigSchema.parse(obsoleteReserve)).toThrow(/completion_reserve_fraction/u);
  });
});

function compactionOf(config: unknown): Record<string, unknown> {
  return (config as { compaction: Record<string, unknown> }).compaction;
}

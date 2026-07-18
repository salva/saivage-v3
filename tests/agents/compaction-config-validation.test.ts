import { describe, expect, it } from '@jest/globals';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

const compaction = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_candidate: { provider: 'test', account: null, model: 'org/summary/model' } } as const;
const models = { max_tokens: { analyst: 200 } };
const required = { card_processes: DEFAULT_CARD_PROCESSES };

describe('compaction config validation', () => {
  it('accepts ordered widths without a second rounded-budget authority', () => {
    expect(saivageConfigSchema.safeParse({ models, compaction, ...required }).success).toBe(true);
  });

  it('requires an explicitly enabled complete structured policy', () => {
    expect(saivageConfigSchema.safeParse({}).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, enabled: false }, ...required }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, input_budget_tokens: undefined }, ...required }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, summarizer_candidate: undefined }, ...required }).success).toBe(false);
    for (const summarizer_candidate of [
      { provider: '', account: null, model: 'model' },
      { provider: 'test', account: null, model: '' },
      { provider: 'test', account: 1, model: 'model' },
      { provider: 'test', account: null, model: 'model', extra: true },
    ]) expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, summarizer_candidate }, ...required }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, summarizer_model: 'test/_/model', summarizer_candidate: undefined }, ...required }).success).toBe(false);
  });

  it('retains independently meaningful width and positive completion checks', () => {
    expect(saivageConfigSchema.safeParse({ models, compaction: { ...compaction, escalate_summary_line_fraction: 0.4, escalate_merge_line_fraction: 0.1 }, ...required }).success).toBe(false);
    const completion = saivageConfigSchema.safeParse({ models, compaction: { ...compaction, input_budget_tokens: 1, completion_reserve_fraction: 0.1 }, ...required });
    expect(completion.success).toBe(false);
    if (!completion.success) expect(completion.error.issues.map((issue) => issue.message)).toContain('compaction reservedCompletionTokens must be positive');
  });

  it.each([
    ['analyst', { analyst: 201, default: 200 }, 201],
    ['default', { default: 201 }, 201],
    ['hard default', undefined, 4096],
  ] as Array<[string, Record<string, number> | undefined, number]>)('rejects a one-token-over or hard-default effective request from %s with the exact diagnostic', (source, max_tokens, requested) => {
    const selectedCompaction = source === 'hard default' ? { ...compaction, input_budget_tokens: 20_475 } : compaction;
    const parsed = saivageConfigSchema.safeParse({ models: max_tokens === undefined ? {} : { max_tokens }, compaction: selectedCompaction, ...required });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues.map((issue) => issue.message)).toContain(
      `Effective Analyst max tokens ${requested} (source: ${source}) exceed reserved completion tokens ${requested - 1} (floor(input_budget_tokens ${selectedCompaction.input_budget_tokens} * completion_reserve_fraction 0.2)). Raise compaction.input_budget_tokens or compaction.completion_reserve_fraction, or lower the configured Analyst max.`,
    );
  });

  it.each([
    ['analyst', { analyst: 200, default: 201 }],
    ['default', { default: 200 }],
    ['hard default', undefined],
  ] as Array<[string, Record<string, number> | undefined]>)('accepts an exact-fit effective request from %s', (source, max_tokens) => {
    const selectedCompaction = source === 'hard default' ? { ...compaction, input_budget_tokens: 20_480 } : compaction;
    expect(saivageConfigSchema.safeParse({ models: max_tokens === undefined ? {} : { max_tokens }, compaction: selectedCompaction, ...required }).success).toBe(true);
  });
});

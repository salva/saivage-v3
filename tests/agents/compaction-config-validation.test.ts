import { describe, expect, it } from '@jest/globals';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';

const compaction = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_candidate: { provider: 'test', account: null, model: 'org/summary/model' } } as const;

describe('compaction config validation', () => {
  it('accepts ordered widths without a second rounded-budget authority', () => {
    expect(saivageConfigSchema.safeParse({ compaction }).success).toBe(true);
  });

  it('requires an explicitly enabled complete structured policy', () => {
    expect(saivageConfigSchema.safeParse({}).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, enabled: false } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, input_budget_tokens: undefined } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, summarizer_candidate: undefined } }).success).toBe(false);
    for (const summarizer_candidate of [
      { provider: '', account: null, model: 'model' },
      { provider: 'test', account: null, model: '' },
      { provider: 'test', account: 1, model: 'model' },
      { provider: 'test', account: null, model: 'model', extra: true },
    ]) expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, summarizer_candidate } }).success).toBe(false);
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, summarizer_model: 'test/_/model', summarizer_candidate: undefined } }).success).toBe(false);
  });

  it('retains independently meaningful width and positive completion checks', () => {
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, escalate_summary_line_fraction: 0.4, escalate_merge_line_fraction: 0.1 } }).success).toBe(false);
    const completion = saivageConfigSchema.safeParse({ compaction: { ...compaction, input_budget_tokens: 1, completion_reserve_fraction: 0.1 } });
    expect(completion.success).toBe(false);
    if (!completion.success) expect(completion.error.issues.map((issue) => issue.message)).toContain('compaction requestedCompletionTokens must be positive');
  });
});

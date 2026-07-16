import { describe, expect, it } from '@jest/globals';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';

const compaction = { enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' } as const;

describe('compaction config validation', () => {
  it('accepts ordered widths without a second rounded-budget authority', () => {
    expect(saivageConfigSchema.safeParse({ compaction }).success).toBe(true);
  });

  it('retains independently meaningful width and positive completion checks', () => {
    expect(saivageConfigSchema.safeParse({ compaction: { ...compaction, escalate_summary_line_fraction: 0.4, escalate_merge_line_fraction: 0.1 } }).success).toBe(false);
    const completion = saivageConfigSchema.safeParse({ compaction: { ...compaction, input_budget_tokens: 1, completion_reserve_fraction: 0.1 } });
    expect(completion.success).toBe(false);
    if (!completion.success) expect(completion.error.issues.map((issue) => issue.message)).toContain('compaction requestedCompletionTokens must be positive');
  });
});

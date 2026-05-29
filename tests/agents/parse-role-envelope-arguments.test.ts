import { describe, it, expect } from '@jest/globals';
import {
  PlannerResultSchema,
  ExecutorResultSchema,
  ReviewerResultSchema,
} from '../../src/agents/role-envelope-schemas.js';
import { parseToolCallArgsAgainstSchema } from '../../src/agents/persisted-tool-call.js';

describe('parseToolCallArgsAgainstSchema — role envelope round-trips', () => {
  it('planner: good args round-trip through PlannerResultSchema', () => {
    const args = {
      status: 'continue' as const,
      created_cards: [],
      updated_cards: [],
      summary: 'plan ok',
    };
    const parsed = parseToolCallArgsAgainstSchema(args, PlannerResultSchema);
    expect(parsed).toMatchObject({ status: 'continue', summary: 'plan ok' });
  });

  it('executor: good args round-trip through ExecutorResultSchema', () => {
    const args = {
      card_id: 'c-1',
      status: 'done' as const,
      status_text: 'completed',
      result: { foo: 1 },
    };
    const parsed = parseToolCallArgsAgainstSchema(args, ExecutorResultSchema);
    expect(parsed).toMatchObject({ card_id: 'c-1', status: 'done', status_text: 'completed', result: { foo: 1 } });
  });

  it('reviewer: good args round-trip through ReviewerResultSchema', () => {
    const args = {
      assessment: {
        result: 'pass' as const,
        summary: 'ok',
        achieved: [],
        issues: [],
        evidence_card_ids: [],
      },
    };
    const parsed = parseToolCallArgsAgainstSchema(args, ReviewerResultSchema);
    expect(parsed).toMatchObject({ assessment: { result: 'pass', summary: 'ok' } });
  });
});

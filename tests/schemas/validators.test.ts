import { describe, it, expect } from '@jest/globals';
import { llmAttemptEventSchema, llmInvocationSummaryEventSchema } from '../../src/schemas/validators.js';

const isoNow = () => new Date().toISOString();

describe('llmAttemptEventSchema envelope', () => {
  it('accepts a valid envelope (succeeded)', () => {
    const evt = {
      id: 'e1', kind: 'llm_attempt', timestamp: isoNow(),
      session_id: 's1', role: 'planner', attempt: 0, same_candidate_attempt: 0,
      provider: 'p', model: 'm', account: '_', started_at: isoNow(), duration_ms: 5,
      outcome: { kind: 'succeeded', terminal_tool: 'emit_result' },
    };
    expect(() => llmAttemptEventSchema.parse(evt)).not.toThrow();
  });
  it('rejects wrong kind literal', () => {
    expect(() => llmAttemptEventSchema.parse({ id: 'e', kind: 'other', timestamp: isoNow() })).toThrow();
  });
  it('rejects unknown envelope field (strict)', () => {
    const evt = {
      id: 'e1', kind: 'llm_attempt', timestamp: isoNow(),
      session_id: 's1', role: 'planner', attempt: 0, same_candidate_attempt: 0,
      provider: 'p', model: 'm', account: '_', started_at: isoNow(), duration_ms: 5,
      outcome: { kind: 'succeeded', terminal_tool: 'emit_result' },
      bogus: true,
    };
    expect(() => llmAttemptEventSchema.parse(evt)).toThrow();
  });
});

describe('llmInvocationSummaryEventSchema envelope', () => {
  it('accepts succeeded with final_* fields', () => {
    const evt = {
      id: 's1', kind: 'llm_invocation_summary', timestamp: isoNow(),
      session_id: 'sess', role: 'planner', goal_id: 'g', card_id: 'c', contract_id: 'planner.v1',
      attempts_count: 1, repair_attempts: 0, total_duration_ms: 12, verdict: 'succeeded',
      final_provider: 'p', final_model: 'm', final_account: '_', final_terminal_tool: 'emit_result',
    };
    expect(() => llmInvocationSummaryEventSchema.parse(evt)).not.toThrow();
  });
  it('rejects succeeded missing final fields', () => {
    const evt = {
      id: 's1', kind: 'llm_invocation_summary', timestamp: isoNow(),
      session_id: 'sess', role: 'planner', goal_id: 'g', card_id: 'c', contract_id: 'planner.v1',
      attempts_count: 1, repair_attempts: 0, total_duration_ms: 12, verdict: 'succeeded',
    };
    expect(() => llmInvocationSummaryEventSchema.parse(evt)).toThrow();
  });
  it('accepts exhausted with last_failure_class', () => {
    const evt = {
      id: 's1', kind: 'llm_invocation_summary', timestamp: isoNow(),
      session_id: 'sess', role: 'planner', goal_id: 'g', card_id: 'c', contract_id: 'planner.v1',
      attempts_count: 3, repair_attempts: 0, total_duration_ms: 30, verdict: 'exhausted',
      last_failure_class: 'rate_limit',
    };
    expect(() => llmInvocationSummaryEventSchema.parse(evt)).not.toThrow();
  });
});

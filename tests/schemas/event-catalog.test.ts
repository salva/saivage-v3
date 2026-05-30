import { describe, it, expect } from '@jest/globals';
import { EventRegistry, payloadSchemaByKind } from '../../src/schemas/event-catalog.js';

const isoNow = () => new Date().toISOString();

const validAttemptSucceeded = {
  session_id: 's1', role: 'planner', attempt: 0, same_candidate_attempt: 0,
  provider: 'p', model: 'm', account: '_', started_at: isoNow(), duration_ms: 12,
  outcome: { kind: 'succeeded', terminal_tool: 'emit_planner_result' },
};
const validAttemptFailed = {
  session_id: 's1', role: 'planner', attempt: 0, same_candidate_attempt: 0,
  provider: 'p', model: 'm', account: '_', started_at: isoNow(), duration_ms: 9,
  outcome: { kind: 'failed', failure_class: 'rate_limit', recovery_action: 'cooldown_and_failover', error_name: 'Error', error_message: 'x' },
};

describe('EventRegistry', () => {
  it('marks llm_attempt and llm_invocation_summary as strict', () => {
    expect(EventRegistry.llm_attempt.strict).toBe(true);
    expect(EventRegistry.llm_invocation_summary.strict).toBe(true);
  });
  it('does not contain legacy llm event kinds', () => {
    const keys = Object.keys(EventRegistry);
    expect(keys).not.toContain('model_selected');
    expect(keys).not.toContain('invocation_succeeded');
    expect(keys).not.toContain('invocation_failed');
    expect(keys).not.toContain('retry_attempted');
  });
});

describe('llm_attempt payload schema', () => {
  const schema = payloadSchemaByKind.llm_attempt;
  it('accepts a succeeded attempt', () => {
    expect(() => schema.parse(validAttemptSucceeded)).not.toThrow();
  });
  it('accepts a failed attempt', () => {
    expect(() => schema.parse(validAttemptFailed)).not.toThrow();
  });
  it('rejects unknown fields (strict)', () => {
    expect(() => schema.parse({ ...validAttemptSucceeded, extra: 1 })).toThrow();
  });
  it('rejects succeeded outcome missing terminal_tool', () => {
    expect(() => schema.parse({ ...validAttemptSucceeded, outcome: { kind: 'succeeded' } })).toThrow();
  });
  it('rejects failed outcome with terminal_tool', () => {
    expect(() => schema.parse({ ...validAttemptFailed, outcome: { ...validAttemptFailed.outcome, terminal_tool: 'emit_planner_result' } })).toThrow();
  });
});

describe('llm_invocation_summary payload schema (refine rules)', () => {
  const schema = payloadSchemaByKind.llm_invocation_summary;
  const base = { session_id: 's', role: 'planner', goal_id: 'g', card_id: 'c', contract_id: 'planner.v1', attempts_count: 1, repair_attempts: 0, total_duration_ms: 10 };
  it('requires final_* when verdict=succeeded', () => {
    expect(() => schema.parse({ ...base, verdict: 'succeeded' })).toThrow();
    expect(() => schema.parse({
      ...base, verdict: 'succeeded',
      final_provider: 'p', final_model: 'm', final_account: '_', final_terminal_tool: 'emit_planner_result',
    })).not.toThrow();
  });
  it('requires last_failure_class when verdict!=succeeded', () => {
    expect(() => schema.parse({ ...base, verdict: 'exhausted' })).toThrow();
    expect(() => schema.parse({ ...base, verdict: 'exhausted', last_failure_class: 'rate_limit' })).not.toThrow();
    expect(() => schema.parse({ ...base, verdict: 'cancelled', last_failure_class: 'cancelled' })).not.toThrow();
  });
  it('accepts optional contract_verdict', () => {
    expect(() => schema.parse({ ...base, verdict: 'exhausted', last_failure_class: 'rate_limit', contract_verdict: 'repair_exhausted' })).not.toThrow();
  });
  it('rejects unknown contract_verdict value', () => {
    expect(() => schema.parse({ ...base, verdict: 'exhausted', last_failure_class: 'rate_limit', contract_verdict: 'bogus' })).toThrow();
  });
});

describe('llm_verifier_rejection payload schema', () => {
  const schema = payloadSchemaByKind.llm_verifier_rejection;
  const valid = {
    session_id: 's', role: 'planner', contract_id: 'planner.v1',
    attempt: 0, repair_round: 1, obligation_codes: ['missing_done_signal'], proposed_present: false,
  };
  it('accepts a valid rejection', () => {
    expect(() => schema.parse(valid)).not.toThrow();
  });
  it('rejects unknown fields (strict)', () => {
    expect(() => schema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it('requires obligation_codes', () => {
    const { obligation_codes: _o, ...rest } = valid;
    expect(() => schema.parse(rest)).toThrow();
  });
});

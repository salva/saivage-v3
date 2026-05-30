import { describe, it, expect } from '@jest/globals';
import { llmVerifierRejectionEventSchema } from '../../src/schemas/validators.js';

const isoNow = () => new Date().toISOString();

describe('llmVerifierRejectionEventSchema', () => {
  const valid = {
    id: 'evt-1', kind: 'llm_verifier_rejection', timestamp: isoNow(),
    session_id: 'sess', role: 'planner', contract_id: 'planner.v1',
    attempt: 0, repair_round: 1, obligation_codes: ['missing_done_signal'], proposed_present: false,
  };
  it('accepts a valid rejection envelope', () => {
    expect(() => llmVerifierRejectionEventSchema.parse(valid)).not.toThrow();
  });
  it('rejects unknown fields (strict)', () => {
    expect(() => llmVerifierRejectionEventSchema.parse({ ...valid, extra: 1 })).toThrow();
  });
  it('rejects when contract_id is missing', () => {
    const { contract_id: _c, ...rest } = valid;
    expect(() => llmVerifierRejectionEventSchema.parse(rest)).toThrow();
  });
  it('rejects when obligation_codes is empty array? (allowed) but missing rejected', () => {
    const { obligation_codes: _o, ...rest } = valid;
    expect(() => llmVerifierRejectionEventSchema.parse(rest)).toThrow();
    expect(() => llmVerifierRejectionEventSchema.parse({ ...valid, obligation_codes: [] })).not.toThrow();
  });
});

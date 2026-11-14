import { describe, expect, it } from '@jest/globals';

import {
  activateCardArgumentsSchema,
  formatActivateCardResult,
  type CardActivationOutcome,
} from '../../src/contracts/tool-api.js';
import { COMPACTION_SUMMARY_BLOCKED_SUMMARY, CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, type BlockedResult } from '../../src/schemas/index.js';
import { settleToolActionOutcome } from '../../src/contracts/tool-result-projection.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

describe('activate_card shared tool contract', () => {
  it('accepts exactly a valid card_id and explicit direction', () => {
    const args = { card_id: 'card-a-b', instructions: 'Complete the child task.' };

    expect(activateCardArgumentsSchema.parse(args)).toEqual(args);
  });

  it('formats content-policy BLOCKED as one exact nested result without duplicate top-level evidence fields', () => {
    const result: BlockedResult = { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: 'agent:executor:card-a', marker_id: 'marker-id', evidence_url: '/agents/agent%3Aexecutor%3Acard-a?entry=marker-id' };
    const formatted = formatActivateCardResult('card-a', { status: 'blocked', summary: result.summary, result });
    expect(formatted).toEqual({ kind: 'succeeded', data: { card_id: 'card-a', outcome: 'blocked', result } });
    expect(formatted).not.toHaveProperty('reason');
    expect(formatted).not.toHaveProperty('evidence_url');
    expect(formatted).not.toHaveProperty('session_id');
    expect(formatted).not.toHaveProperty('marker_id');
  });

  it.each([
    ['missing card_id', {}],
    ['missing instructions', { card_id: 'card-a' }],
    ['extra field', { card_id: 'card-a', instructions: 'Direction', extra: true }],
    ['invalid card_id', { card_id: 'card-1', instructions: 'Direction' }],
  ])('rejects %s', (_name, value) => {
    expect(activateCardArgumentsSchema.safeParse(value).success).toBe(false);
  });

  it('requires each outcome variant exact result shape and forbids a cancelled result', () => {
    const outcomes: CardActivationOutcome[] = [
      { status: 'done', summary: 'done summary', result: workflowResult('DONE', 'done result') },
      { status: 'failed', summary: 'failed summary', result: runtimeFailure('failed result') },
      { status: 'blocked', summary: 'blocked summary', result: workflowResult('BLOCKED', 'blocked result') },
      { status: 'cancelled', summary: 'cancelled summary' },
    ];

    // @ts-expect-error done outcomes require a DoneResult
    const doneWithoutResult: CardActivationOutcome = { status: 'done', summary: 'missing' };
    // @ts-expect-error failed outcomes require a FailedResult
    const failedWithoutResult: CardActivationOutcome = { status: 'failed', summary: 'missing' };
    // @ts-expect-error blocked outcomes require a BlockedResult
    const blockedWithoutResult: CardActivationOutcome = { status: 'blocked', summary: 'missing' };
    // @ts-expect-error rework is not a current blocked activation result
    const blockedWithRework: CardActivationOutcome = { status: 'blocked', summary: 'revise', result: { kind: 'rework', summary: 'revise' } };
    // @ts-expect-error cancelled outcomes have no result field
    const cancelledWithResult: CardActivationOutcome = { status: 'cancelled', summary: 'cancelled', result: { kind: 'failed', summary: 'invalid' } };

    expect(outcomes.map(({ status }) => status)).toEqual(['done', 'failed', 'blocked', 'cancelled']);
    void doneWithoutResult;
    void failedWithoutResult;
    void blockedWithoutResult;
    void blockedWithRework;
    void cancelledWithResult;
  });

  it.each([
    {
      outcome: { status: 'done', summary: 'done summary', result: workflowResult('DONE', 'done result') } as const,
      expected: { kind: 'succeeded', data: { card_id: 'card-a', outcome: 'done', result: workflowResult('DONE', 'done result') } },
    },
    {
      outcome: { status: 'blocked', summary: 'blocked summary', result: workflowResult('BLOCKED', 'blocked result') } as const,
      expected: { kind: 'succeeded', data: { card_id: 'card-a', outcome: 'blocked', result: workflowResult('BLOCKED', 'blocked result') } },
    },
    {
      outcome: { status: 'failed', summary: 'failed summary', result: runtimeFailure('failed result') } as const,
      expected: { kind: 'succeeded', data: { card_id: 'card-a', outcome: 'failed', result: runtimeFailure('failed result') } },
    },
    {
      outcome: { status: 'cancelled', summary: 'cancelled summary' } as const,
      expected: { kind: 'failed', error: "Child card 'card-a' activation was cancelled.", data: { card_id: 'card-a', outcome: 'cancelled', summary: 'cancelled summary' } },
    },
    {
      outcome: { status: 'stopped', summary: 'stopped summary' } as const,
      expected: { kind: 'failed', error: "Child card 'card-a' activation was stopped.", data: { card_id: 'card-a', outcome: 'stopped', summary: 'stopped summary' } },
    },
  ])('formats the $outcome.status result envelope', ({ outcome, expected }) => {
    expect(formatActivateCardResult('card-a', outcome)).toEqual(expected);
  });

  const qualifiedSummary = 'CSV export is implemented on source X; retry round-trip failed. Fix retry handling and verify X before independent review. Task-owned worker remains allocated; release is unconfirmed.';
  const statusRecord = { name: 'status.md', url: 'record:///status.md?card=card-a&v=3', version: 3 };
  const auditResult = workflowResult('BLOCKED', qualifiedSummary, { records: [statusRecord] });
  const settlements: CardActivationOutcome[] = [
    { status: 'done', summary: 'internal done', result: workflowResult('DONE', 'Implementation complete; parent acceptance is not asserted.') },
    { status: 'failed', summary: 'internal failed', result: workflowResult('FAILED', 'Verification failed after partial implementation.') },
    { status: 'blocked', summary: 'internal blocked', result: { ...auditResult, records: [statusRecord, { name: 'review.md', url: 'record:///review.md?card=card-a&v=2', version: 2 }] } },
    { status: 'failed', summary: 'internal runtime failure', result: runtimeFailure('Worker cleanup unconfirmed; effects may have occurred.') },
    { status: 'blocked', summary: 'internal provider refusal', result: { kind: 'content-policy-refusal', summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: 'agent:executor:card-a', marker_id: 'refusal-marker', evidence_url: '/agents/agent%3Aexecutor%3Acard-a?entry=refusal-marker' } },
    { status: 'blocked', summary: 'internal compaction refusal', result: { kind: 'compaction-summary-blocked', summary: COMPACTION_SUMMARY_BLOCKED_SUMMARY, session_id: 'agent:executor:card-a', summary_input_id: '11111111-1111-4111-8111-111111111111' } },
    { status: 'blocked', summary: 'internal native blocked', result: { kind: 'git-workflow-blocked', step: 'verifyCorrection', invocation_id: '22222222-2222-4222-8222-222222222222', summary: 'Correction verification failed; source changes remain, delivery not confirmed.' } },
    { status: 'cancelled', summary: 'Cancelled with partial effects; resource release unconfirmed.' },
    { status: 'stopped', summary: 'Stopped before verification; effects remain uncertain.' },
  ];

  it.each(settlements)('settles $status with exact typed evidence or the sole interruption narrative: $summary', (outcome) => {
    const settled = settleToolActionOutcome(formatActivateCardResult('card-a', outcome));
    const envelope = JSON.parse(settled.settledResultBytes);
    expect(envelope).toEqual(settled.providerResult);
    if ('result' in outcome) {
      expect(envelope).toEqual({ success: true, data: { card_id: 'card-a', outcome: outcome.status, result: outcome.result } });
      expect(envelope.data).not.toHaveProperty('summary');
      expect(envelope.data.result).toEqual(outcome.result);
      if (outcome.result.kind === 'workflow-result')
        for (const record of outcome.result.records) expect(Object.keys(record).sort()).toEqual(['name', 'url', 'version']);
    } else {
      expect(envelope).toEqual({ success: false, error: `Child card 'card-a' activation was ${outcome.status}.`, data: { card_id: 'card-a', outcome: outcome.status, summary: outcome.summary } });
      expect(envelope.data).not.toHaveProperty('result');
    }
    expect(settled.settledResultBytes).not.toContain('"content":');
    expect(settled.settledResultBytes).not.toContain('"body":');
  });

  it('measures only the audit-equivalent synthetic summary subtraction', () => {
    const { settledResultBytes: after } = settleToolActionOutcome(formatActivateCardResult('card-a', { status: 'blocked', summary: qualifiedSummary, result: auditResult }));
    const parsed = JSON.parse(after);
    // Reconstruct the exact prior formatter payload, without changing its typed result.
    const before = JSON.stringify({ data: { ...parsed.data, summary: qualifiedSummary }, success: true });
    expect(Buffer.byteLength(qualifiedSummary)).toBe(183);
    expect(Buffer.byteLength(before)).toBe(689);
    expect(Buffer.byteLength(after)).toBe(493);
    expect(Buffer.byteLength(before) - Buffer.byteLength(after)).toBe(196);
    expect(parsed.data.result.records).toEqual([statusRecord]);
  });
});

import { describe, expect, it } from '@jest/globals';

import {
  activateCardArgumentsSchema,
  formatActivateCardResult,
  parseActivateCardArguments,
  type ActivateCardToolResult,
  type CardActivationOutcome,
} from '../../src/contracts/tool-api.js';
import type { BlockedResult } from '../../src/schemas/index.js';
import { runtimeFailure, workflowResult } from '../helpers/workflow-result.js';

describe('activate_card shared tool contract', () => {
  it('accepts exactly one valid card_id', () => {
    const args = { card_id: 'card-a-b' };

    expect(activateCardArgumentsSchema.parse(args)).toEqual(args);
    expect(parseActivateCardArguments(args)).toEqual(args);
  });

  it.each([
    ['missing card_id', {}],
    ['extra field', { card_id: 'card-a', extra: true }],
    ['invalid card_id', { card_id: 'card-1' }],
  ])('rejects %s', (_name, value) => {
    expect(activateCardArgumentsSchema.safeParse(value).success).toBe(false);
    expect(() => parseActivateCardArguments(value)).toThrow();
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

    const exactBlocked: BlockedResult = workflowResult('BLOCKED', 'blocked result');
    const exactBlockedToolResult: ActivateCardToolResult = { success: true, data: { card_id: 'card-a', outcome: 'blocked', summary: exactBlocked.summary, result: exactBlocked } };
    // @ts-expect-error activate_card tool results do not admit rework
    const reworkToolResult: ActivateCardToolResult = { success: true, data: { card_id: 'card-a', outcome: 'blocked', summary: 'revise', result: { kind: 'rework', summary: 'revise' } } };

    expect(outcomes.map(({ status }) => status)).toEqual(['done', 'failed', 'blocked', 'cancelled']);
    void doneWithoutResult;
    void failedWithoutResult;
    void blockedWithoutResult;
    void blockedWithRework;
    void cancelledWithResult;
    void exactBlockedToolResult;
    void reworkToolResult;
  });

  it.each([
    {
      outcome: { status: 'done', summary: 'done summary', result: workflowResult('DONE', 'done result') } as const,
      expected: { success: true, data: { card_id: 'card-a', outcome: 'done', summary: 'done summary', result: workflowResult('DONE', 'done result') } },
    },
    {
      outcome: { status: 'blocked', summary: 'blocked summary', result: workflowResult('BLOCKED', 'blocked result') } as const,
      expected: { success: true, data: { card_id: 'card-a', outcome: 'blocked', summary: 'blocked summary', result: workflowResult('BLOCKED', 'blocked result') } },
    },
    {
      outcome: { status: 'failed', summary: 'failed summary', result: runtimeFailure('failed result') } as const,
      expected: { success: true, data: { card_id: 'card-a', outcome: 'failed', summary: 'failed summary', result: runtimeFailure('failed result') } },
    },
    {
      outcome: { status: 'cancelled', summary: 'cancelled summary' } as const,
      expected: { success: false, error: "Child card 'card-a' activation was cancelled." },
    },
  ])('formats the $outcome.status result envelope', ({ outcome, expected }) => {
    expect(formatActivateCardResult('card-a', outcome)).toEqual(expected);
  });
});

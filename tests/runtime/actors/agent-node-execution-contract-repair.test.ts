import { describe, expect, it } from '@jest/globals';
import { z } from 'zod';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/llm-actor.js';
import { AppLogPublicationError } from '../../../src/persistence/app-log.js';
import type { InvocationSurface, ToolProviderCleanupReason } from '../../../src/tools/invocation.js';

type ToolOutcome = Extract<LLMActorOutcome, { type: 'tool_call' }>;

const resultOutcome: Extract<LLMActorOutcome, { type: 'result' }> = {
  type: 'result',
  agentId: 'agent:planner:project',
  result: { kind: 'message', content: 'plain text' },
};

function terminal(id: string, ...provided: [unknown?]): ToolOutcome {
  const args = provided.length === 0 ? { outcome: 'complete', summary: 'finished' } : provided[0];
  return { type: 'tool_call', agentId: 'agent:planner:project', inputId: id, toolCallId: id, toolName: 'emit_result', args };
}

function nonterminal(id: string): ToolOutcome {
  return { type: 'tool_call', agentId: 'agent:planner:project', inputId: id, toolCallId: id, toolName: 'lookup', args: {} };
}

function harness(args: {
  initial: LLMActorOutcome;
  continuations?: LLMActorOutcome[];
  toolExecutor?: () => Promise<{ success: true; data: string }>;
  cleanupError?: Error;
}) {
  const events: string[] = [];
  const handoffs: unknown[] = [];
  const cleanupReasons: ToolProviderCleanupReason[] = [];
  const appendedToolResults: Array<{ toolCallId: string; result: unknown }> = [];
  const llmInputArguments: unknown[][] = [];
  const continuations = [...(args.continuations ?? [])];
  const next = (): LLMActorOutcome => {
    const outcome = continuations.shift();
    if (!outcome) throw new Error('Test continuation queue exhausted.');
    return outcome;
  };
  const llm = {
    turn: async (_input: unknown, _signal: AbortSignal, handoff: unknown) => { events.push('turn'); handoffs.push(handoff); return args.initial; },
    continueAfterPlainText: async (_correction: string, _signal: AbortSignal, handoff: unknown) => { events.push('continue-plain-text'); handoffs.push(handoff); return next(); },
    appendToolResult: async (toolCallId: string, result: unknown) => { events.push(`append:${toolCallId}`); appendedToolResults.push({ toolCallId, result }); return next(); },
    toolInvocationContext: () => { events.push('tool-context'); return {}; },
    claimResultAndCloseContinuation: (_outcome: ToolOutcome, _reason: Error, claim: () => void) => { events.push('claim-continuation'); claim(); },
    settleToolResultWithoutContinuation: async () => { events.push('settle-terminal'); },
  };
  const provider = {
    providerName: 'node-test',
    tools: args.toolExecutor ? [{ name: 'lookup', description: 'lookup', inputSchema: z.object({}).strict(), executor: async () => {
      events.push('tool-execute');
      return args.toolExecutor!();
    } }] : [],
    cleanup: async (reason: ToolProviderCleanupReason) => {
      events.push('cleanup');
      cleanupReasons.push(reason);
      if (args.cleanupError) throw args.cleanupError;
    },
  };
  const surface: InvocationSurface = {
    agentName: 'planner',
    tools: new Map(provider.tools.map((tool) => [tool.name, tool])),
    providers: [provider],
  };
  const card = { id: 'project', type: 'project', title: 'Project' };
  const node = {
    kind: 'node',
    nodeId: 'work',
    agent: { name: 'planner', tools: [], model: { temperature: 0, maxTokens: 100 } },
    requirements: [],
    descendantContext: null,
    outcomes: ['complete'],
    childCreationTypes: new Set(),
    childActivationTypes: new Set(),
  };
  const stateId = 'node:work';
  const process = {
    cardType: 'project',
    states: new Map<string, unknown>([
      [stateId, node],
      ['terminal:DONE', { kind: 'terminal', terminal: 'DONE' }],
    ]),
    definition: { states: new Map([[stateId, { on: new Map([['result:complete', { target: 'terminal:DONE' }]]) }]]) },
  };
  const input = {
    card,
    activationId: 'activation-1',
    alreadyStabilizedAgents: new Set(),
    notificationDelivery: { selectNotifications: () => [], removeNotifications: () => undefined },
    claimResult: () => { events.push('claim-result'); },
  };
  const execution = new AgentNodeExecution({
    cardId: 'project',
    store: { read: () => card, listChildren: () => [] },
    processPrompts: { get: () => 'correct the result' },
  } as never, {
    createLlm: () => llm,
    selectLlm: () => undefined,
    freshInputId: () => 'input-1',
    assertCurrentActivation: () => { events.push('current'); },
    assertPromotionAvailable: () => { events.push('promotion'); },
  } as never);
  const internals = execution as unknown as {
    prepareNodeEntry: () => void;
    buildLlmInput: (...args: unknown[]) => object;
    buildSurface: () => InvocationSurface;
    correction: (_node: unknown, violations: readonly string[]) => string;
    closeAcceptedRecords: () => Array<{ name: string; url: string; version: number }>;
  };
  internals.prepareNodeEntry = () => undefined;
  internals.buildLlmInput = (...values) => { llmInputArguments.push(values); return {}; };
  internals.buildSurface = () => surface;
  internals.correction = (_node, violations) => `correction: ${violations.join('; ')}`;
  internals.closeAcceptedRecords = () => { events.push('close-records'); return []; };

  return {
    events,
    handoffs,
    cleanupReasons,
    appendedToolResults,
    llmInputArguments,
    run: () => execution.execute({ process, stateId, node, transition: {}, input, signal: new AbortController().signal, nodeOrdinal: 0 } as never),
  };
}

const objectGuardCorrection = "correction: Terminal tool 'emit_result' arguments must be a JSON object.";
const missingSummaryCorrection = `correction: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "undefined",
    "path": [
      "summary"
    ],
    "message": "Required"
  }
]`;
const extraFieldCorrection = `correction: [
  {
    "code": "unrecognized_keys",
    "keys": [
      "extra"
    ],
    "path": [],
    "message": "Unrecognized key(s) in object: 'extra'"
  }
]`;
const unknownOutcomeCorrection = `correction: [
  {
    "received": "unknown",
    "code": "invalid_enum_value",
    "options": [
      "complete"
    ],
    "path": [
      "outcome"
    ],
    "message": "Invalid enum value. Expected 'complete', received 'unknown'"
  }
]`;
const nonStringSummaryCorrection = `correction: [
  {
    "code": "invalid_type",
    "expected": "string",
    "received": "number",
    "path": [
      "summary"
    ],
    "message": "Expected string, received number"
  }
]`;
const whitespaceSummaryCorrection = `correction: [
  {
    "code": "too_small",
    "minimum": 1,
    "type": "string",
    "inclusive": true,
    "exact": false,
    "message": "String must contain at least 1 character(s)",
    "path": [
      "summary"
    ]
  }
]`;
const overLimitSummaryCorrection = `correction: [
  {
    "code": "too_big",
    "maximum": 2000,
    "type": "string",
    "inclusive": true,
    "exact": false,
    "message": "String must contain at most 2000 character(s)",
    "path": [
      "summary"
    ]
  }
]`;

describe('AgentNodeExecution contract repair behavior', () => {
  it.each([
    ['null', null],
    ['array', []],
    ['non-object scalar', 42],
    ['undefined', undefined],
    ['false', false],
    ['zero', 0],
    ['empty string', ''],
  ])('preserves the exact pre-schema object-guard correction for %s arguments', async (_label, args) => {
    const test = harness({ initial: terminal('invalid', args), continuations: [terminal('accepted')] });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'invalid', result: { success: false, error: objectGuardCorrection } });
  });

  it.each([
    ['missing summary', { outcome: 'complete' }, missingSummaryCorrection],
    ['extra field', { outcome: 'complete', summary: 'ok', extra: true }, extraFieldCorrection],
    ['unknown outcome', { outcome: 'unknown', summary: 'ok' }, unknownOutcomeCorrection],
    ['non-string summary', { outcome: 'complete', summary: 42 }, nonStringSummaryCorrection],
    ['whitespace-only summary', { outcome: 'complete', summary: '   ' }, whitespaceSummaryCorrection],
    ['over-limit summary', { outcome: 'complete', summary: 'x'.repeat(2001) }, overLimitSummaryCorrection],
  ])('preserves the exact strict-schema correction for an object with %s', async (_label, args, expected) => {
    const test = harness({ initial: terminal('invalid', args), continuations: [terminal('accepted')] });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'invalid', result: { success: false, error: expected } });
    expect(expected).not.toContain("Terminal tool 'emit_result' arguments must be a JSON object.");
  });

  it('continues terminal-contract repairs beyond five attempts', async () => {
    const invalid = (id: string) => terminal(id, { outcome: 'complete' });
    const test = harness({
      initial: invalid('invalid-0'),
      continuations: [invalid('invalid-1'), invalid('invalid-2'), invalid('invalid-3'), invalid('invalid-4'), invalid('invalid-5'), terminal('accepted', { outcome: 'complete', summary: '  finished  ' })],
    });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete', summary: 'finished' });
    expect(test.events.filter((event) => event.startsWith('append:'))).toHaveLength(6);
    expect(test.appendedToolResults).toEqual(Array.from({ length: 6 }, (_, index) => ({ toolCallId: `invalid-${index}`, result: { success: false, error: missingSummaryCorrection } })));
  });

  it('throws an actor provider error and still cleans up the failed activation', async () => {
    const test = harness({ initial: { type: 'error', agentId: 'agent:planner:project', error: 'provider unavailable' } });

    await expect(test.run()).rejects.toThrow('provider unavailable');
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });

  it('checks currentness around plain-text repair before accepting the continuation', async () => {
    const test = harness({ initial: resultOutcome, continuations: [terminal('accepted')] });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.events.slice(0, 5)).toEqual(['turn', 'current', 'current', 'continue-plain-text', 'current']);
    expect(test.handoffs).toHaveLength(2);
    expect(test.handoffs[1]).toBe(test.handoffs[0]);
  });

  it('invokes and appends a nonterminal result before continuing to terminal acceptance', async () => {
    const test = harness({ initial: nonterminal('lookup-1'), continuations: [terminal('accepted')], toolExecutor: async () => ({ success: true, data: 'found' }) });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.events).toEqual(expect.arrayContaining(['tool-context', 'tool-execute', 'append:lookup-1', 'settle-terminal', 'cleanup']));
    expect(test.events.indexOf('tool-execute')).toBeLessThan(test.events.indexOf('append:lookup-1'));
    expect(test.events.indexOf('append:lookup-1')).toBeLessThan(test.events.indexOf('claim-continuation'));
    expect(test.events[test.events.indexOf('append:lookup-1') - 1]).toBe('current');
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'lookup-1', result: { success: true, data: 'found' } });
  });

  it('accepts an immutable terminal result before successful cleanup', async () => {
    const test = harness({ initial: terminal('accepted') });

    const accepted = await test.run();
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.acceptedRecords)).toBe(true);
    expect(test.llmInputArguments[0]?.[4]).toBe('Call emit_result with exactly two fields: outcome (one of: complete) and summary (a trimmed non-empty string of at most 2000 characters).');
    expect(test.llmInputArguments[0]?.[6]).toEqual({
      type: 'function',
      function: {
        name: 'emit_result',
        description: 'Emit the configured process-node result as the final action of this turn.',
        parameters: {
          type: 'object',
          properties: {
            outcome: { type: 'string', enum: ['complete'] },
            summary: { type: 'string', minLength: 1 },
          },
          additionalProperties: false,
          required: ['outcome', 'summary'],
        },
      },
    });
    expect(test.events.slice(-9)).toEqual([
      'promotion',
      'claim-continuation',
      'claim-result',
      'current',
      'close-records',
      'settle-terminal',
      'current',
      'current',
      'cleanup',
    ]);
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'done' }]);
  });

  it('rethrows app-log publication failure after cleanup and ahead of cleanup failure', async () => {
    const publication = new AppLogPublicationError('event', new Error('write failed'));
    const cleanup = new Error('cleanup failed');
    const test = harness({ initial: nonterminal('lookup-1'), toolExecutor: async () => { throw publication; }, cleanupError: cleanup });

    await expect(test.run()).rejects.toBe(publication);
    expect(test.cleanupReasons).toEqual([{ kind: 'publication_terminal', error: publication }]);
    expect(test.events.slice(-2)).toEqual(['tool-execute', 'cleanup']);
  });
});

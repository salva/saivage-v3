import { describe, expect, it, jest } from '@jest/globals';
import { z } from 'zod';

import { AgentNodeExecution } from '../../../src/runtime/actors/agent-node-execution.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/llm-actor.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { defineTool, executedNoneSettlement, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface, type ToolProviderCleanupReason } from '../../../src/tools/invocation.js';
import { toolFailed, toolSucceeded } from '../../../src/contracts/tool-result.js';

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
  terminalVariant?: 'pending' | 'records' | 'stale' | 'incomplete';
  agentTools?: string[];
  reviewerPreparationError?: Error;
  writtenRecords?: string[];
  discardError?: Error;
  useRealCorrection?: boolean;
}) {
  const events: string[] = [];
  const handoffs: unknown[] = [];
  const cleanupReasons: ToolProviderCleanupReason[] = [];
  const appendedToolResults: Array<{ toolCallId: string; result: unknown }> = [];
  const settledToolResults: Array<{ toolCallId: string; result: unknown }> = [];
  const llmInputArguments: unknown[][] = [];
  const plainTextCorrections: string[] = [];
  const continuations = [...(args.continuations ?? [])];
  const next = (): LLMActorOutcome => {
    const outcome = continuations.shift();
    if (!outcome) throw new Error('Test continuation queue exhausted.');
    return outcome;
  };
  const llm = {
    turn: async (_input: unknown, _signal: AbortSignal, handoff: unknown) => { events.push('turn'); handoffs.push(handoff); return args.initial; },
    continueAfterPlainText: async (correction: string, _signal: AbortSignal, handoff: unknown) => { events.push('continue-plain-text'); plainTextCorrections.push(correction); handoffs.push(handoff); return next(); },
    appendToolResult: async (toolCallId: string, result: unknown) => { events.push(`append:${toolCallId}`); appendedToolResults.push({ toolCallId, result }); return { outcome: next(), settled: {} }; },
    toolInvocationContext: () => { events.push('tool-context'); return {}; },
    claimResultAndCloseContinuation: (_outcome: ToolOutcome, _reason: Error, claim: () => void) => { events.push('claim-continuation'); claim(); },
    settleToolResultWithoutContinuation: async (toolCallId: string, result: unknown) => { events.push('settle-terminal'); settledToolResults.push({ toolCallId, result }); },
  };
  const provider = {
    providerName: 'node-test',
    tools: args.toolExecutor ? [defineTool({ name: 'lookup', description: 'lookup', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: z.object({}).strict(), executor: async () => {
      events.push('tool-execute');
      const result = await args.toolExecutor!();
      return executedToolOutcome('none', toolSucceeded(result.data));
    } })] : [],
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
    promptId: 'work',
    correctionPromptId: 'correct',
    agent: { name: 'planner', tools: args.agentTools ?? [], model: { temperature: 0, maxTokens: 100 } },
    requirements: args.terminalVariant === 'records' ? [{ mode: 'continue', gate: 'updated', definition: { name: 'status.md' } }] : [],
    descendantContext: args.terminalVariant === 'stale' || args.reviewerPreparationError ? { records: [] } : null,
    on: new Map([['result:complete', Object.freeze({targetStateId:'terminal:DONE',reenter:false,semantic:Object.freeze({kind:'configured-outcome',outcome:'complete',promptId:null,terminalBehavior:Object.freeze({promotion:Object.freeze({kind:'current'}),exportRecords:Object.freeze([])})})})]]),
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
    processPrompts: new Map([['work', { text: 'perform the current work' }], ['correct', { text: 'correct the result' }]]),
  };
  const selectNotifications = args.terminalVariant === 'pending'
    ? jest.fn().mockReturnValueOnce([{ id: 'notice-1', content: 'operator context' }]).mockReturnValue([])
    : () => [];
  const input = {
    card,
    activationId: 'activation-1',
    notificationDelivery: { selectNotifications, removeNotifications: () => undefined },
    claimResult: () => { events.push('claim-result'); },
  };
  const createDirectScope = jest.fn(() => ({}));
  const execution = new AgentNodeExecution({
    cardId: 'project',
    store: {
      read: (id: string) => id === 'card-a' ? { id, lifecycle: { status: 'running' } } : card,
      readRecordCurrent: (_cardId: string, name: string) => { events.push(`read-record:${name}`); return { kind: 'found', value: { projection: { headVersion: 1, currentUrl: `record:///${name}?card=project`, versionUrl: `record:///${name}?card=project&v=1`, artifact: { state: 'open', accepted: null, draft: { content: 'draft' } } } } }; },
      discardRecord: (_cardId: string, name: string) => { events.push(`discard-record:${name}`); if (name === 'beta.md' && args.discardError) throw args.discardError; },
      listChildren: args.terminalVariant === 'incomplete' ? jest.fn().mockReturnValueOnce(['card-a']).mockReturnValue([]) : () => [],
    },
    processRunner: { createDirectScope },
    runtimeProcessRootScope: {},
    workflows: { agentBindings: new Map([['planner', { toolSet: { requiresProcessScope: false } }]]) },
  } as never, {
    createLlm: () => llm,
    selectLlm: () => undefined,
    freshInputId: () => 'input-1',
    assertCurrentActivation: () => { events.push('current'); },
    assertPromotionAvailable: () => { events.push('promotion'); },
  } as never);
  const internals = execution as unknown as {
    prepareNodeEntry: () => void;
    prepareRecordRequirements: () => void;
    captureRecordHead: () => number | null;
    prepareNodeInvocation: (...args: unknown[]) => object;
    enterNodeConversation: (prepared: object) => object;
    buildSurface: (...args: unknown[]) => InvocationSurface;
    correction: (_process: unknown, _node: unknown, violations: readonly string[]) => string;
    closeAcceptedRecords: () => Array<{ name: string; url: string; version: number }>;
    validateRecords: () => { candidates: Map<string, unknown> } | { violations: string[] };
    captureReviewerPair: () => unknown;
    reviewerStaleReason: () => string | null;
  };
  internals.prepareNodeEntry = () => undefined;
  internals.prepareRecordRequirements = () => undefined;
  internals.captureRecordHead = () => 1;
  internals.prepareNodeInvocation = (...values) => { llmInputArguments.push(values); return { inputId: 'input-1' }; };
  internals.enterNodeConversation = (prepared) => ({ ...prepared, providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] } });
  internals.buildSurface = (...values) => { const written=values[5] as Set<string>;for(const name of args.writtenRecords??[])written.add(name);return surface; };
  if (!args.useRealCorrection) internals.correction = (_process, _node, violations) => `correction: ${violations.join('; ')}`;
  internals.closeAcceptedRecords = () => { events.push('close-records'); return []; };
  if (args.reviewerPreparationError) internals.captureReviewerPair = () => { throw args.reviewerPreparationError; };
  if (args.terminalVariant === 'records') {
    let validationCount = 0;
    internals.validateRecords = () => validationCount++ === 0
      ? { violations: ['required record is invalid'] }
      : { candidates: new Map() };
  }
  if (args.terminalVariant === 'stale') {
    internals.captureReviewerPair = () => ({ exactContext: { role: 'user', content: 'context' }, snapshot: {} });
    let staleCount = 0;
    internals.reviewerStaleReason = () => staleCount++ === 0 ? 'changed' : null;
  }

  return {
    events,
    handoffs,
    cleanupReasons,
    appendedToolResults,
    settledToolResults,
    llmInputArguments,
    plainTextCorrections,
    createDirectScope,
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
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'invalid', result: executedNoneSettlement(toolFailed(objectGuardCorrection)) });
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
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'invalid', result: executedNoneSettlement(toolFailed(expected)) });
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
    expect(test.appendedToolResults).toEqual(Array.from({ length: 6 }, (_, index) => ({ toolCallId: `invalid-${index}`, result: executedNoneSettlement(toolFailed(missingSummaryCorrection)) })));
  });

  it('throws an actor provider error and still cleans up the failed activation', async () => {
    const test = harness({ initial: { type: 'error', agentId: 'agent:planner:project', error: 'provider unavailable' } });

    await expect(test.run()).rejects.toThrow('provider unavailable');
    expect(test.cleanupReasons).toEqual([{ kind: 'activation_settled', status: 'failed' }]);
  });

  it('finishes throwing reviewer preparation before allocating a direct process scope', async () => {
    const preparationFailure = new Error('reviewer context preparation failed');
    const test = harness({ initial: terminal('unused'), agentTools: ['run_command'], reviewerPreparationError: preparationFailure });

    await expect(test.run()).rejects.toBe(preparationFailure);
    expect(test.createDirectScope).not.toHaveBeenCalled();
    expect(test.cleanupReasons).toEqual([]);
  });

  it('checks currentness around plain-text repair before accepting the continuation', async () => {
    const test = harness({ initial: resultOutcome, continuations: [terminal('accepted')], useRealCorrection: true });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.events.slice(0, 5)).toEqual(['turn', 'current', 'current', 'continue-plain-text', 'current']);
    expect(test.handoffs).toHaveLength(2);
    expect(test.handoffs[1]).toBe(test.handoffs[0]);
    expect(test.plainTextCorrections).toEqual(['correct the result\n\nValidation errors:\n- emit_result is required.']);
  });

  it('invokes and appends a nonterminal result before continuing to terminal acceptance', async () => {
    const test = harness({ initial: nonterminal('lookup-1'), continuations: [terminal('accepted')], toolExecutor: async () => ({ success: true, data: 'found' }) });

    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    expect(test.events).toEqual(expect.arrayContaining(['tool-context', 'tool-execute', 'append:lookup-1', 'settle-terminal', 'cleanup']));
    expect(test.events.indexOf('tool-execute')).toBeLessThan(test.events.indexOf('append:lookup-1'));
    expect(test.events.indexOf('append:lookup-1')).toBeLessThan(test.events.indexOf('claim-continuation'));
    expect(test.events[test.events.indexOf('append:lookup-1') - 1]).toBe('current');
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'lookup-1', result: executedNoneSettlement(toolSucceeded('found')) });
  });

  it('accepts an immutable terminal result before successful cleanup', async () => {
    const test = harness({ initial: terminal('accepted') });

    const accepted = await test.run();
    expect(Object.isFrozen(accepted)).toBe(true);
    expect(Object.isFrozen(accepted.acceptedRecords)).toBe(true);
    expect(test.llmInputArguments[0]?.[3]).toBe('Call emit_result with exactly two fields: outcome (one of: complete) and summary (a trimmed non-empty string of at most 2000 characters).');
    expect(test.llmInputArguments[0]?.[5]).toEqual({
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
    expect(test.settledToolResults).toEqual([{ toolCallId: 'accepted', result: executedNoneSettlement(toolSucceeded({ accepted: true })) }]);
  });

  const settlementCases: Array<[string, NonNullable<Parameters<typeof harness>[0]['terminalVariant']>, unknown]> = [
    ['pending notifications', 'pending', { success: false, error: 'emit_result was not accepted because operator context is pending.', data: { reason: 'pending_notifications' } }],
    ['record violations', 'records', { success: false, error: 'correction: required record is invalid' }],
    ['stale descendant context', 'stale', { success: false, error: 'Review context is stale: changed.' }],
    ['incomplete descendant completion', 'incomplete', { success: false, error: "correction: Completion gate failed: descendant 'card-a' is 'running'." }],
  ];
  it.each(settlementCases)('validates the %s settlement before append', async (_label, terminalVariant, expected) => {
    const test = harness({ initial: terminal('rejected'), continuations: [terminal('accepted')], terminalVariant });
    await expect(test.run()).resolves.toMatchObject({ outcome: 'complete' });
    const failure = expected as { error: string; data?: unknown };
    expect(test.appendedToolResults[0]).toEqual({ toolCallId: 'rejected', result: executedNoneSettlement(toolFailed(failure.error, failure.data)) });
  });

  it('rethrows publication uncertainty before cleanup', async () => {
    const publication = new PublicationOutcomeUnknownError();
    const cleanup = new Error('cleanup failed');
    const test = harness({ initial: nonterminal('lookup-1'), toolExecutor: async () => { throw publication; }, cleanupError: cleanup });

    await expect(test.run()).rejects.toBe(publication);
    expect(test.cleanupReasons).toEqual([]);
    expect(test.events.at(-1)).toBe('tool-execute');
  });

  it('discards activation-written drafts in sorted prefix order before cleanup on graceful failure', async () => {
    const test=harness({initial:{type:'error',agentId:'agent:planner:project',error:'provider unavailable'},writtenRecords:['gamma.md','beta.md','alpha.md'],discardError:new Error('discard failed')});
    await expect(test.run()).rejects.toThrow('discard failed');
    expect(test.events.filter((event)=>event.startsWith('read-record:')||event.startsWith('discard-record:')||event==='cleanup')).toEqual([
      'read-record:alpha.md','discard-record:alpha.md','read-record:beta.md','discard-record:beta.md','cleanup',
    ]);
  });

  it('bypasses invocation-surface cleanup after publication-unknown draft discard', async () => {
    const publication=new PublicationOutcomeUnknownError();
    const test=harness({initial:{type:'error',agentId:'agent:planner:project',error:'provider unavailable'},writtenRecords:['beta.md','alpha.md'],discardError:publication});
    await expect(test.run()).rejects.toBe(publication);
    expect(test.events.filter((event)=>event.startsWith('read-record:')||event.startsWith('discard-record:')||event==='cleanup')).toEqual([
      'read-record:alpha.md','discard-record:alpha.md','read-record:beta.md','discard-record:beta.md',
    ]);
  });
});

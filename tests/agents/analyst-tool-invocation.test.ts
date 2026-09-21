import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystRuntime, AnalystSession, AnalystTurnBusyError } from '../../src/agents/analyst-handler.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { defineTool, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface, type ToolExecutionResult } from '../../src/tools/invocation.js';
import { toolFailed, toolSucceeded } from '../../src/contracts/tool-result.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { appendConversationBatch, readConversation, readCurrentConversationSegment } from '../../src/persistence/conversation-file.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort, type RestartCapability } from '../../src/contracts/index.js';
import { globalAgentConversationVersionFile } from '../../src/persistence/layout.js';
import { deterministicRoundId } from '../../src/schemas/round-id-server.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { toolCallRowPolicy } from '../helpers/row-policy-fixtures.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function toolCall(argumentsJson: string, toolName = 'demo'): ProviderTurnCompletion {
  return {
    result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: toolName, arguments: argumentsJson } }] },
    provider_exchanges: [],
  };
}

function analyst(
  argumentsJson: string,
  executor: (args: { value: string }, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<ToolExecutionResult<'none'>>,
  options: { toolName?: string; restartCapability?: RestartCapability; beforeContinuation?: (projectRoot: string) => void; fatalPort?: ApplicationFatalPort; conversationChanged?: (target: { session_id: string; segment_version: number; visible_message_id: string | null }) => void } = {},
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-tool-invocation-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const definition = defineTool({
    name: options.toolName ?? 'demo',
    description: 'Demo tool.',
    resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
    inputSchema: z.object({ value: z.string() }).strict(),
    executor,
  });
  const surface: InvocationSurface = { agentName: 'analyst', tools: new Map([[definition.name, definition]]), providers: [{ providerName: 'demo', tools: [definition] }] };
  const capabilityRequest = { requiresTools: true, requiresExclusiveToolChoice: true } as const;
  let turns = 0;
  const completeTurn = jest.fn(async (_input:LlmInvocationInput): Promise<ProviderTurnCompletion> => {
    turns += 1;
    if (turns === 1) return toolCall(argumentsJson, options.toolName);
    options.beforeContinuation?.(projectRoot);
    return { result: { kind: 'message', content: 'done' }, provider_exchanges: [] };
  });
  const session = new AnalystSession({
    cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
    fatalPort: options.fatalPort ?? testApplicationFatalPort,
    sessionId: 'agent:analyst:global',
    agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest,
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    routeUsableInputTokens: 80_000,
    promptTemplates: { render: () => 'test analyst prompt' },
    restartCapability: options.restartCapability ?? { available: false },
    provider: scriptedAdmissionProvider(completeTurn),
    conversations: options.conversationChanged ? { projectRoot, changes: { conversationChanged: options.conversationChanged, agentMembershipChanged() {} } } : { projectRoot },
    compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: () => Promise.reject(new Error('Unexpected compaction.')) },
    summarizerProvider: unusedSummarizerProvider,
    cardStore: new CardService(projectRoot),
    runtimeCurrent: () => ({ status: 'stopped' as const, currentCardId: null }),
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses: async () => {},
  });
  const createSession = jest.fn(() => session);
  const runtime = new AnalystRuntime({ createSession, getAvailableToolNames: () => [definition.name], terminateRoot: async () => ({ selected: [], stopped: [], failed: [] }) });
  return { session, runtime, createSession, completeTurn, capabilityRequest, projectRoot };
}

describe('Analyst parsed tool invocation', () => {
  it('admits one synchronous turn owner, rejects overlap as typed busy, and never queues the loser', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const executor = jest.fn(async () => {
      await blocked;
      return executedToolOutcome('none', toolSucceeded('done'));
    });
    const test = analyst('{"value":"ok"}', executor);

    const winner = test.session.submit({ userContent: 'first' });
    const loser = test.session.submit({ userContent: 'second' });
    await expect(loser).rejects.toBeInstanceOf(AnalystTurnBusyError);
    await new Promise((resolve) => setImmediate(resolve));
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    expect(test.completeTurn.mock.calls[0]![0].capabilityRequest).toBe(test.capabilityRequest);

    release();
    await expect(winner).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(test.completeTurn).toHaveBeenCalledTimes(2);
    await expect(test.session.submit({ userContent: 'later' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(test.completeTurn).toHaveBeenCalledTimes(3);
    expect(executor).toHaveBeenCalledTimes(1);
  });

  it('does not classify ordinary synchronous input rejection as busy', async () => {
    const test = analyst('{"value":"ok"}', jest.fn(async () => executedToolOutcome('none', toolSucceeded('unused'))));
    const rejected = test.session.submit({ userContent: '   ' });
    await expect(rejected).rejects.toThrow('must not be empty');
    await expect(rejected).rejects.not.toBeInstanceOf(AnalystTurnBusyError);
  });

  it.each([
    { raw: '{', violation: 'tool_args_invalid_json' },
    { raw: '[]', violation: 'tool_args_not_object' },
  ])('keeps $violation in the Analyst protocol-violation branch', async ({ raw, violation }) => {
    const executor = jest.fn(async () => executedToolOutcome('none', toolSucceeded('unused')));
    const test = analyst(raw, executor);

    const response = await test.session.submit({ userContent: 'test malformed arguments' });

    expect(executor).not.toHaveBeenCalled();
    expect(response.toolInvocations).toHaveLength(1);
    expect(response.toolInvocations![0]!.params).toEqual({});
    const result = response.toolInvocations![0]!.result;
    if (result.success) throw new Error('Expected malformed arguments to fail.');
    expect(JSON.parse(result.error)).toMatchObject({ kind: 'agent_protocol_violation', violation });
  });

  it('passes a valid parsed object and complete actor-built context directly to the LLM invocation boundary', async () => {
    let receivedContext: LlmToolInvocationContext | undefined;
    const executor = jest.fn(async (args: { value: string }, _signal: AbortSignal, context?: LlmToolInvocationContext) => {
      receivedContext = context;
      return executedToolOutcome('none', toolSucceeded(args));
    });
    const test = analyst('{"value":"ok"}', executor);

    const response = await test.session.submit({ userContent: 'test valid arguments' });
    const invocation = response.toolInvocations![0]!;

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toEqual({ value: 'ok' });
    expect(invocation.params).toEqual({ value: 'ok' });
    expect(invocation.result).toEqual({ success: true, data: { value: 'ok' } });
    expect(receivedContext).toMatchObject({
      sessionId: 'agent:analyst:global',
      sourceInputId: invocation.sourceInputId,
      toolCallId: 'call-1',
      toolName: 'demo',
      waits: { waitExternal: expect.any(Function), waitProcess: expect.any(Function) },
      childInvocation: { reserveChild: expect.any(Function) },
    });
    expect(receivedContext!.childInvocation.identity).toEqual({
      sessionId: 'agent:analyst:global',
      sourceInputId: invocation.sourceInputId,
      toolCallId: 'call-1',
      toolName: 'demo',
    });
  });

  it('keeps valid-object schema rejection at the invocation boundary', async () => {
    const executor = jest.fn(async () => executedToolOutcome('none', toolSucceeded('unused')));
    const test = analyst('{"value":1}', executor);

    const response = await test.session.submit({ userContent: 'test schema rejection' });

    expect(executor).not.toHaveBeenCalled();
    expect(response.toolInvocations![0]!.params).toEqual({ value: 1 });
    expect(response.toolInvocations![0]!.result).toMatchObject({ success: false, error: expect.stringContaining('Expected string') });
  });

  it('returns the exact durable settled failure only after append and before ordinary continuation', async () => {
    let durableAtContinuation: string | undefined;
    const test = analyst(
      '{"value":"denied"}',
      jest.fn(async () => executedToolOutcome('none', toolFailed('denied token=sk-a', { code: 'structured_denial', detail: 'sk-a' }))),
      {
        beforeContinuation(projectRoot) {
          const row = readConversation(projectRoot, 'agent:analyst:global').sourceRows.find((candidate) => candidate.kind === 'tool_result');
          durableAtContinuation = row?.content;
        },
      },
    );

    const response = await test.session.submit({ userContent: 'perform denied operation' });
    const invocation = response.toolInvocations![0]!;
    const durable = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.find((row) => row.kind === 'tool_result');

    expect(test.completeTurn).toHaveBeenCalledTimes(2);
    expect(durableAtContinuation).toBeDefined();
    expect(durable?.content).toBe(durableAtContinuation);
    expect(canonicalJson(invocation.result)).toBe(durable!.content);
    expect(invocation.result).toEqual({ success: false, error: 'denied token=[REDACTED]', data: { code: 'structured_denial', detail: 'sk-[REDACTED]' } });
  });

  it('durably settles restart success without entering an ordinary continuation', async () => {
    const test = analyst(
      '{"value":"restart"}',
      jest.fn(async () => executedToolOutcome('none', toolSucceeded({ restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' }))),
      { toolName: 'restart_server', restartCapability: { available: true, port: { schedule() {}, acknowledge: async () => {} } } },
    );

    const response = await test.session.submit({ userContent: 'request restart' });
    const durable = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.find((row) => row.kind === 'tool_result');

    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    expect(response.restart).toEqual({ status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
    expect(response.toolInvocations).toHaveLength(1);
    expect(canonicalJson(response.toolInvocations![0]!.result)).toBe(durable!.content);
  });

  it.each([
    { label: 'ordinary raw failure', failure: new Error('raw invoked-tool failure') },
    { label: 'tool-consumed invariant failure', failure: new TypeError('configured tool invariant failure') },
  ])('releases only an abandoned $label for one later explicit submission', async ({ failure }) => {
    let effects = 0;
    const test = analyst('{"value":"effect"}', jest.fn(async () => {
      effects += 1;
      throw failure;
    }));

    await expect(test.runtime.submit({ userContent: 'perform once' })).rejects.toBe(failure);
    const stranded = readConversation(test.projectRoot, 'agent:analyst:global');
    expect(stranded.unmatchedCall?.toolCallId).toBe('call-1');
    expect(stranded.sourceRows.filter((row) => row.kind === 'tool_result')).toHaveLength(0);
    expect(effects).toBe(1);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);

    await expect(test.runtime.submit({ userContent: 'fresh request' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });

    const rows = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows;
    const oldCallIndex = rows.findIndex((row) => row.kind === 'tool_call' && row.tool_call_id === 'call-1');
    const mateIndex = rows.findIndex((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-1');
    const freshMarkerIndex = rows.findIndex((row, index) => index > mateIndex && row.kind === 'activity' && (JSON.parse(row.content) as { event?: string }).event === 'activation_open');
    expect(oldCallIndex).toBeGreaterThanOrEqual(0);
    expect(mateIndex).toBe(oldCallIndex + 1);
    expect(freshMarkerIndex).toBe(mateIndex + 1);
    expect(JSON.parse(rows[mateIndex]!.content)).toEqual({
      success: false,
      error: 'Prior activation ended without a recorded tool result. External or domain effects may or may not have happened. The prior call will not be replayed.',
      data: { outcome_unknown: true },
    });
    expect(rows[mateIndex]).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'execution_failed', evidence: { kind: 'none' } } });
    expect(effects).toBe(1);
    expect(test.completeTurn).toHaveBeenCalledTimes(2);
    expect(test.createSession).toHaveBeenCalledTimes(1);

    await expect(test.runtime.submit({ userContent: 'another fresh request' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-1')).toHaveLength(1);
  });

  it('keeps invoked-tool publication uncertainty fatal and permanently unadmitted for settlement', async () => {
    const publication = new PublicationOutcomeUnknownError(new Error('uncertain tool publication'));
    const publicationOutcomeUnknown = jest.fn(() => undefined as never);
    const abandonParkedTurn = jest.spyOn(ConversationLLMActor.prototype, 'abandonParkedTurn');
    const test = analyst('{"value":"uncertain"}', jest.fn(async () => { throw publication; }), {
      fatalPort: { publicationOutcomeUnknown },
    });

    await expect(test.runtime.submit({ userContent: 'uncertain effect' })).rejects.toBe(publication);
    expect(publicationOutcomeUnknown).toHaveBeenCalledWith(publication);
    expect(abandonParkedTurn).not.toHaveBeenCalled();
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    expect(readConversation(test.projectRoot, 'agent:analyst:global').unmatchedCall?.toolCallId).toBe('call-1');

    await expect(test.runtime.submit({ userContent: 'must not recover' })).rejects.toBe(publication);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    expect(readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'tool_result')).toHaveLength(0);
    expect(abandonParkedTurn).not.toHaveBeenCalled();
  });

  it('preserves a disposal reason thrown across invoked-tool cancellation instead of wrapping it', async () => {
    const reason = new Error('application disposal won tool invocation');
    let test!: ReturnType<typeof analyst>;
    const executor = jest.fn(async (_args: { value: string }, signal: AbortSignal) => {
      test.session.disposeSession(reason);
      signal.throwIfAborted();
      throw new Error('aborted invocation unexpectedly continued');
    });
    test = analyst('{"value":"dispose"}', executor);

    await expect(test.runtime.submit({ userContent: 'dispose during tool invocation' })).rejects.toBe(reason);
    await expect(test.session.submit({ userContent: 'later' })).rejects.toBe(reason);
    expect(executor).toHaveBeenCalledTimes(1);
    expect(readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-1')).toHaveLength(1);
  });

  it('keeps the session poisoned when parked-turn abandonment fails', async () => {
    const invocationFailure = new Error('tool escaped');
    const abandonmentFailure = new Error('parked turn abandonment failed');
    jest.spyOn(ConversationLLMActor.prototype, 'abandonParkedTurn').mockImplementationOnce(() => { throw abandonmentFailure; });
    const test = analyst('{"value":"fail"}', jest.fn(async () => { throw invocationFailure; }));

    await expect(test.runtime.submit({ userContent: 'first' })).rejects.toBe(abandonmentFailure);
    await expect(test.runtime.submit({ userContent: 'later' })).rejects.toBe(abandonmentFailure);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    expect(readConversation(test.projectRoot, 'agent:analyst:global').unmatchedCall?.toolCallId).toBe('call-1');
  });

  it.each(['settlement', 'following ingress'] as const)('keeps %s publication uncertainty fatal without replay or provider continuation', async (boundary) => {
    const toolFailure = new Error('strand one call');
    const publication = new PublicationOutcomeUnknownError(new Error(`${boundary} uncertain`));
    const publicationOutcomeUnknown = jest.fn(() => undefined as never);
    let armed = false;
    let publications = 0;
    const test = analyst('{"value":"strand"}', jest.fn(async () => { throw toolFailure; }), {
      fatalPort: { publicationOutcomeUnknown },
      conversationChanged() {
        if (!armed) return;
        publications += 1;
        if (publications === (boundary === 'settlement' ? 1 : 2)) throw publication;
      },
    });
    await expect(test.runtime.submit({ userContent: 'strand' })).rejects.toBe(toolFailure);
    armed = true;

    await expect(test.runtime.submit({ userContent: 'fresh but uncertain' })).rejects.toBe(publication);
    expect(publicationOutcomeUnknown).toHaveBeenCalledWith(publication);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
    const rows = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'call-1')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'activity' && (JSON.parse(row.content) as { event?: string }).event === 'activation_open')).toHaveLength(boundary === 'settlement' ? 1 : 2);
    await expect(test.runtime.submit({ userContent: 'must remain failed' })).rejects.toBe(publication);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
  });

  it.each(['complete malformed data', 'nonfinal unmatched call', 'multiple unmatched calls'] as const)('strictly rejects %s at fresh Analyst submission before ingress or provider work', async (fixture) => {
    const firstFailure = new Error('seed unmatched call');
    const test = analyst('{"value":"seed"}', jest.fn(async () => { throw firstFailure; }));
    await expect(test.runtime.submit({ userContent: 'seed' })).rejects.toBe(firstFailure);
    const segment = readCurrentConversationSegment(test.projectRoot, 'agent:analyst:global')!;
    const path = globalAgentConversationVersionFile(test.projectRoot, 'analyst', segment.entry.filename);
    if (fixture === 'complete malformed data') {
      appendFileSync(path, '{"version":2,"type":"conversation-segment","rows":[{"broken":true}]}\n');
    } else if (fixture === 'nonfinal unmatched call') {
      const marker = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows.find((row) => row.kind === 'activity')!;
      const inputId = '22222222-2222-4222-8222-222222222222';
      appendRaw(path, { ...marker, id: `${marker.id}-later`, content: JSON.stringify({ event: 'activation_open', agent_name: 'analyst', input_id: inputId, timestamp: marker.timestamp }), round_id: deterministicRoundId('pre', inputId) });
    } else {
      const call = readConversation(test.projectRoot, 'agent:analyst:global').unmatchedCall!.message;
      const inputId = '33333333-3333-4333-8333-333333333333';
      appendRaw(path, { ...call, id: `${inputId}:tool-call:call-2`, tool_call_id: 'call-2', round_id: deterministicRoundId('assistant', inputId), content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'demo', arguments: '{"value":"again"}' } }] }) });
    }

    await expect(test.runtime.submit({ userContent: 'must reject corrupt state' })).rejects.toThrow(/malformed|invalid|unmatched/u);
    expect(test.completeTurn).toHaveBeenCalledTimes(1);
  });

  it('settles a seeded selected-session call with its persisted policy before fresh Analyst ingress', async () => {
    const test = analyst('{"value":"new"}', jest.fn(async (args) => executedToolOutcome('none', toolSucceeded(args))));
    const oldInput = '44444444-4444-4444-8444-444444444444';
    const ingress = buildAnalystIngressRows('agent:analyst:global', oldInput, 'old workspace', 'old request');
    appendConversationBatch({ projectRoot: test.projectRoot }, ingress);
    const oldPolicy = toolCallRowPolicy();
    if (oldPolicy.kind !== 'tool_call') throw new Error('Expected tool-call policy fixture.');
    appendConversationBatch({ projectRoot: test.projectRoot }, [{
      id: `${oldInput}:tool-call:old-policy-call`, session_id: 'agent:analyst:global', role: 'assistant', kind: 'tool_call', tool: 'old_tool', tool_call_id: 'old-policy-call', context_policy: oldPolicy,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'old-policy-call', type: 'function', function: { name: 'old_tool', arguments: '{}' } }] }), round_id: deterministicRoundId('assistant', oldInput), message_index: 3, block_index: 0, timestamp: ingress[2].timestamp,
    }]);
    const segment = readCurrentConversationSegment(test.projectRoot, 'agent:analyst:global')!;
    const segmentPath = globalAgentConversationVersionFile(test.projectRoot, 'analyst', segment.entry.filename);
    const prefix = readFileSync(segmentPath);

    await expect(test.runtime.submit({ userContent: 'fresh request' })).resolves.toMatchObject({ sessionId: 'agent:analyst:global' });
    expect(readFileSync(segmentPath).subarray(0, prefix.length)).toEqual(prefix);
    const rows = readConversation(test.projectRoot, 'agent:analyst:global').sourceRows;
    const mate = rows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'old-policy-call');
    expect(mate).toMatchObject({ context_policy: { kind: 'tool_result', call_policy_sha256: oldPolicy.template_sha256, settlement_origin: 'execution_failed', evidence: { kind: 'none' } } });
    const mateIndex = rows.indexOf(mate!);
    expect(rows[mateIndex + 1]).toMatchObject({ kind: 'activity' });
    expect(readConversation(test.projectRoot, 'agent:analyst:global').unmatchedCall).toBeNull();
  });
});

function appendRaw(path: string, row: unknown): void {
  appendFileSync(path, `${JSON.stringify({ version: 2, type: 'conversation-segment', rows: [row] })}\n`);
}

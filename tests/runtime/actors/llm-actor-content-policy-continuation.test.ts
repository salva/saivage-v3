import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InvocationService } from '../../../src/agents/invocation-service.js';
import { MemoryCandidateAvailability } from '../../../src/agents/candidate-availability.js';
import { createInvocationServiceProvider } from '../../../src/application/invocation-service-provider.js';
import { NO_FRESHNESS_EFFECTS, PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../../../src/contracts/index.js';
import { toolSucceeded } from '../../../src/contracts/tool-result.js';
import {
  ConversationLLMActor,
  type LlmTerminalHandoff,
} from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import {
  buildPreparedInvocationContext,
  compileInvocationToolContract,
} from '../../../src/runtime/actors/context/context-blocks.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import {
  appendConversationBatch,
  readConversation,
} from '../../../src/persistence/conversation-file.js';
import { readProviderExchangeEntries } from '../../../src/persistence/provider-exchange-log.js';
import {
  agentMessageSchema,
  CONTENT_POLICY_RETRY_TEXT,
  parseCanonicalContentPolicyRefusal,
} from '../../../src/schemas/index.js';
import {
  executedNoneSettlement,
  OPERATIONAL_RESULT_POLICY_TEMPLATE,
  syntheticToolSettlement,
} from '../../../src/tools/invocation.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import {
  chatSuccess,
  invocationProviderRegistry,
} from '../../helpers/invocation-provider-fixture.js';
import { testCompactor, unusedSummarizerProvider } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

const FIRST = { provider: 'first', account: null, model: 'm1' } as const;
const SECOND = { provider: 'second', account: null, model: 'm2' } as const;
const CHAIN = [FIRST, SECOND];
const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function refusal(message = 'content policy refusal'): Response {
  return new Response(JSON.stringify({ error: { code: 'content_filter', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json' },
  });
}
function toolResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'probe-call', type: 'function', function: { name: 'probe', arguments: '{}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}
type WireRequest = {
  messages: Array<{
    role: string;
    content: string | null;
    tool_call_id?: string;
    tool_calls?: unknown[];
  }>;
};
function fixture(
  responses: Array<() => Response | Promise<Response>>,
  terminalTool = false,
  contextWindowTokens = 100_000,
  fatalPort: ApplicationFatalPort = testApplicationFatalPort,
) {
  const root = mkdtempSync(join(tmpdir(), 'llm-content-policy-continuation-'));
  roots.push(root);
  initProjectTree(root);
  const sessionId = 'agent:planner:project' as const;
  const inputId = '00000000-0000-4000-8000-000000000001';
  const timestamp = '2026-10-12T00:00:00.000Z';
  appendConversationBatch({ projectRoot: root }, [
    agentMessageSchema.parse({
      id: 'activation',
      session_id: sessionId,
      role: 'system',
      kind: 'activity',
      content: JSON.stringify({
        event: 'activation_open',
        instructions: {
          kind: 'prepared',
          role_text: 'system',
          node: { node_id: 'synthetic-probe', text: 'bounded synthetic probe instructions' },
        },
        agent_name: 'planner',
        card_id: 'project',
        input_id: inputId,
        timestamp,
      }),
      context_policy: { kind: 'structural', behavior: 'activation_boundary' },
      round_id: 'r-pre-00000000000000000000000000000000',
      message_index: 0,
      block_index: 0,
      timestamp,
    }),
  ]);
  const contract = compileInvocationToolContract(
    {
      type: 'function',
      function: {
        name: 'probe',
        description: 'bounded synthetic probe',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    OPERATIONAL_RESULT_POLICY_TEMPLATE,
  );
  const tools = [contract.providerDefinition];
  const terminalToolNames = terminalTool ? ['probe'] : [];
  const preparedCompaction = prepareCompaction(
    {
      context_utilization_fraction: 0.8,
      trigger_fraction: 0.8,
      tail_fraction: 0.25,
      snap: 'compact_straddler',
    },
    'system',
    tools,
    contextWindowTokens,
    100,
  );
  const input: PreparedLlmInvocationInput = {
    inputId,
    agentId: sessionId,
    agentName: 'planner',
    sessionId,
    systemPrompt: 'system',
    providerConversation: { sourceSessionId: sessionId, messages: [] },
    tools,
    compiledToolContracts: [contract],
    terminalToolNames,
    modelParams: { temperature: 0 },
    preparedCompaction,
    preparedContext: buildPreparedInvocationContext({
      instructionText: 'system',
      terminalToolNames,
      compiledTools: [contract],
      dynamicBlocks: [],
      preparedCompaction,
    }),
    capabilityRequest: { requiresTools: true },
    routePass: { kind: 'ordinary', candidateChain: CHAIN },
    episodeContext: { synthetic: 'episode' },
  };
  const availability = new MemoryCandidateAvailability();
  const service = new InvocationService({
    projectRoot: root,
    registry: invocationProviderRegistry(CHAIN, {
      first: { contextWindowTokens },
      second: { contextWindowTokens },
    }),
    candidateAvailability: availability,
    freshness: NO_FRESHNESS_EFFECTS,
  });
  const admission = jest.spyOn(service, 'preparePrimaryRequestAdmission');
  const pinned = jest.spyOn(service, 'preflightPinnedContentPolicyRequest');
  const projection = jest.spyOn(service, 'projectProviderExchanges');
  const actor = new ConversationLLMActor({
    purpose: { kind: 'autonomous-card', cardId: 'project' },
    gate: new RuntimeGate(),
    agentId: sessionId,
    provider: createInvocationServiceProvider(service, root),
    conversations: { projectRoot: root },
    compactor: testCompactor,
    summarizerProvider: unusedSummarizerProvider,
    fatalPort,
  });
  const requests: WireRequest[] = [];
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    expect(new URL(String(url)).hostname).toBe('first.example.test');
    const respond = responses[requests.length];
    if (!respond) throw new Error('Unexpected synthetic provider transport.');
    requests.push(JSON.parse(String(init?.body)) as WireRequest);
    return respond();
  });
  const handoff = jest.fn<LlmTerminalHandoff>();
  const rows = () => readConversation(root, sessionId).sourceRows;
  return {
    root,
    input,
    actor,
    service,
    availability,
    admission,
    pinned,
    projection,
    requests,
    fetch,
    handoff,
    rows,
  };
}

function expectFreshOrdinary(f: ReturnType<typeof fixture>) {
  expect(f.admission).toHaveBeenCalledTimes(2);
  const next = f.admission.mock.calls[1]![0];
  expect(next.routePass).toEqual({ kind: 'ordinary', candidateChain: CHAIN });
  expect(next.inputId).not.toBe(f.input.inputId);
  expect(next.inputId).toMatch(/^[0-9a-f-]{36}$/);
  expect(next.preparedContext).toBe(f.input.preparedContext);
  expect(next.preparedCompaction).toBe(f.input.preparedCompaction);
  expect(next.tools).toBe(f.input.tools);
  expect(next.modelParams).toBe(f.input.modelParams);
  expect(next.capabilityRequest).toBe(f.input.capabilityRequest);
  expect(next.providerConversation.sourceSessionId).toBe(f.input.sessionId);
  expect(next.providerConversation.messages).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        kind: 'synthetic_context',
        origin: 'retry_notice',
        content: CONTENT_POLICY_RETRY_TEXT,
      }),
    ]),
  );
  expect(f.pinned.mock.calls[0]![0]).toMatchObject({
    inputId: f.input.inputId,
    routePass: { kind: 'pinned-content-policy-retry', candidate: FIRST },
  });
  expect(f.projection).toHaveBeenCalledTimes(2);
  expect(f.projection.mock.calls[0]![3]).toMatchObject([
    { source_input_id: f.input.inputId, attempt_index: 0, status: 'error' },
    { source_input_id: f.input.inputId, attempt_index: 1, status: 'ok' },
  ]);
  expect(f.projection.mock.calls[0]![3]).toHaveLength(2);
  expect(f.projection.mock.calls[1]![3]).toMatchObject([
    { source_input_id: next.inputId, attempt_index: 0, status: 'ok' },
  ]);
  expect(f.projection.mock.calls[1]![3]).toHaveLength(1);
  expect(f.fetch).toHaveBeenCalledTimes(3);
  expect(f.rows().filter((row) => row.kind === 'content_policy_retry')).toHaveLength(1);
  expect(f.rows().filter((row) => row.kind === 'content_policy_refusal')).toHaveLength(0);
  return next;
}

describe('content-policy successful pin continuation ownership', () => {
  it.each([false, true])('post-overload actor evidence publication retains exact error identity (unknown=%s) and never resends', async unknown => {
    jest.useFakeTimers();
    const failure = unknown ? new PublicationOutcomeUnknownError(new Error('synthetic uncertainty')) : new Error('ordinary evidence publication failure');
    const fatal = jest.fn((error: PublicationOutcomeUnknownError): never => { throw error; });
    const f = fixture([() => refusal(), () => new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 }), () => chatSuccess('known output')], false, 100_000, { publicationOutcomeUnknown: fatal });
    f.projection.mockImplementation(() => { throw failure; });
    let settled = false;
    const pending = f.actor.turn(f.input, undefined, f.handoff).then(result => { settled = true; return result; }, error => { settled = true; return error; });
    await jest.advanceTimersByTimeAsync(30_000);
    if (unknown) expect(settled).toBe(false);
    else expect(await pending).toBe(failure);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(f.projection).toHaveBeenCalledTimes(1);
    expect(f.handoff).not.toHaveBeenCalled();
    expect(fatal).toHaveBeenCalledTimes(unknown ? 1 : 0);
    if (unknown) expect(fatal).toHaveBeenCalledWith(failure);
    await jest.advanceTimersByTimeAsync(7_200_000);
    expect(f.fetch).toHaveBeenCalledTimes(3);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('retries a real admitted pin through overload then retries fresh ordinary tool continuation without replay', async () => {
    jest.useFakeTimers();
    const overload = () => new Response(JSON.stringify({ error: { code: 'server_is_overloaded' } }), { status: 503 });
    const f = fixture([() => refusal(), ...Array.from({ length: 7 }, () => overload), toolResponse,
      ...Array.from({ length: 5 }, () => overload), () => chatSuccess('done')]);
    f.availability.markFailed(SECOND, { state: 'BLOCKED_UNTIL', untilMs: Date.now() + 7_200_000, reason: 'rate_limit' });
    const first = f.actor.turn(f.input, undefined, f.handoff);
    await jest.advanceTimersByTimeAsync(2_130_000);
    const outcome = await first;
    if (outcome.type !== 'tool_call') throw new Error('Expected probe call.');
    expect(f.pinned).toHaveBeenCalledTimes(1);
    expect(f.requests.slice(1, 9)).toEqual(Array(8).fill(f.requests[1]));
    expect(f.rows().filter(row => row.kind === 'content_policy_retry')).toHaveLength(1);
    expect(f.projection).toHaveBeenCalledTimes(1);
    expect(f.projection.mock.calls[0]![3].map(attempt => attempt.attempt_index)).toEqual(Array.from({ length: 9 }, (_, i) => i));
    const execute = jest.fn(() => executedNoneSettlement(toolSucceeded({ once: true })));
    const continuation = f.actor.appendToolResult(outcome.toolCallId, execute());
    await jest.advanceTimersByTimeAsync(930_000);
    await expect(continuation).resolves.toMatchObject({ outcome: { type: 'result' } });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(f.rows().filter(row => row.kind === 'tool_call')).toHaveLength(1);
    expect(f.rows().filter(row => row.kind === 'tool_result')).toHaveLength(1);
    expect(f.admission).toHaveBeenCalledTimes(2);
    const next = f.admission.mock.calls[1]![0];
    expect(next.inputId).not.toBe(f.input.inputId);
    expect(next.routePass).toEqual({ kind: 'ordinary', candidateChain: CHAIN });
    expect(next.preparedContext).toBe(f.input.preparedContext);
    expect(f.requests.slice(9)).toEqual(Array(6).fill(f.requests[9]));
    expect(f.projection).toHaveBeenCalledTimes(2);
    expect(f.projection.mock.calls[1]![3]).toHaveLength(6);
    expect(new Set(f.projection.mock.calls[1]![3].map(attempt => attempt.source_input_id))).toEqual(new Set([next.inputId]));
    expect(readProviderExchangeEntries(f.root, f.input.sessionId)).toHaveLength(15);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('overload on the pin followed by a second real refusal blocks once with no third authorization', async () => {
    jest.useFakeTimers();
    const overload = () => new Response(JSON.stringify({ error: { code: 'overloaded' } }), { status: 503 });
    const f = fixture([() => refusal(), ...Array.from({ length: 5 }, () => overload), () => refusal('second refusal')]);
    const pending = f.actor.turn(f.input, undefined, f.handoff);
    await jest.advanceTimersByTimeAsync(930_000);
    await expect(pending).resolves.toMatchObject({ type: 'blocked' });
    expect(f.fetch).toHaveBeenCalledTimes(7);
    expect(f.admission).toHaveBeenCalledTimes(1);
    expect(f.pinned).toHaveBeenCalledTimes(1);
    expect(f.rows().filter(row => row.kind === 'content_policy_retry')).toHaveLength(1);
    expect(f.rows().filter(row => row.kind === 'content_policy_refusal')).toHaveLength(1);
    expect(f.projection).toHaveBeenCalledTimes(1);
    expect(readProviderExchangeEntries(f.root, f.input.sessionId).map(entry => entry.data.attempt_index)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('settles one synthetic tool once and freshly admits the complete original ordinary chain', async () => {
    const f = fixture([() => refusal(), toolResponse, () => chatSuccess('done')]);
    const outcome = await f.actor.turn(f.input, undefined, f.handoff);
    if (outcome.type !== 'tool_call') throw new Error('Expected probe call.');
    expect(f.actor.waitingToolInput(outcome)).toMatchObject({
      routePass: f.input.routePass,
      episodeContext: f.input.episodeContext,
    });
    const execute = jest.fn(async (args: unknown) => {
      expect(args).toEqual({});
      return executedNoneSettlement(toolSucceeded({ probe: 'known synthetic result' }));
    });
    const settlement = await execute(JSON.parse(f.actor.waitingToolArguments(outcome)));
    await expect(f.actor.appendToolResult(outcome.toolCallId, settlement)).resolves.toMatchObject({
      outcome: { type: 'result' },
    });
    expect(execute).toHaveBeenCalledTimes(1);
    const next = expectFreshOrdinary(f);
    expect(f.rows().filter((row) => row.kind === 'tool_call')).toHaveLength(1);
    const results = f.rows().filter((row) => row.kind === 'tool_result');
    expect(results).toHaveLength(1);
    expect(results[0]!.id).toBe(`${f.input.inputId}:tool-result:probe-call`);
    expect(f.requests[2]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'tool',
          tool_call_id: 'probe-call',
          content: expect.stringContaining('known synthetic result'),
        }),
        expect.objectContaining({ role: 'assistant', tool_calls: expect.any(Array) }),
        expect.objectContaining({ content: CONTENT_POLICY_RETRY_TEXT }),
      ]),
    );
    const evidence = readProviderExchangeEntries(f.root, f.input.sessionId);
    expect(evidence.map((entry) => entry.data)).toMatchObject([
      {
        source_input_id: f.input.inputId,
        attempt_index: 0,
        payload: { status: 'error', terminal_conversation_output_id: null },
      },
      {
        source_input_id: f.input.inputId,
        attempt_index: 1,
        payload: {
          status: 'ok',
          assistant_output_ids: [`${f.input.inputId}:tool-call:probe-call`],
        },
      },
      {
        source_input_id: next.inputId,
        attempt_index: 0,
        payload: { status: 'ok', assistant_output_ids: expect.any(Array) },
      },
    ]);
    expect(evidence).toHaveLength(3);
    expect(f.projection.mock.calls[0]![4]).toMatchObject({
      assistantOutputIds: [`${f.input.inputId}:tool-call:probe-call`],
    });
    expect(next.providerConversation.messages.length).toBeGreaterThan(
      f.pinned.mock.calls[0]![0].providerConversation.messages.length,
    );
    await expect(f.actor.appendToolResult(outcome.toolCallId, settlement)).rejects.toThrow(
      /not waiting/,
    );
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it('hands off the actual pinned plaintext then uses refreshed history for configured repair', async () => {
    const f = fixture([
      () => refusal(),
      () => chatSuccess('safe answer'),
      () => chatSuccess('repaired'),
    ]);
    await expect(f.actor.turn(f.input, undefined, f.handoff)).resolves.toMatchObject({
      type: 'result',
    });
    const completed = f.handoff.mock.calls[0]![0].input;
    expect(completed.routePass).toEqual({ kind: 'pinned-content-policy-retry', candidate: FIRST });
    expect(completed.preparedContext).toBe(f.input.preparedContext);
    expect(completed.providerConversation.messages.at(-1)).toMatchObject({
      origin: 'retry_notice',
    });
    expect(f.fetch).toHaveBeenCalledTimes(2);
    await expect(
      f.actor.continueAfterPlainText(
        [
          {
            role: 'user',
            content: 'configured repair',
            protection: { compactable: false, compaction_key: 'repair' },
          },
        ],
        undefined,
        f.handoff,
      ),
    ).resolves.toMatchObject({ type: 'result' });
    expectFreshOrdinary(f);
    expect(f.rows().filter((row) => row.kind === 'model_repair')).toHaveLength(1);
    const output = f
      .rows()
      .find((row) => row.role === 'assistant' && row.content === 'safe answer')!;
    expect(
      readProviderExchangeEntries(f.root, f.input.sessionId).map((entry) => entry.data),
    ).toMatchObject([
      {
        source_input_id: f.input.inputId,
        attempt_index: 0,
        payload: { status: 'error', terminal_conversation_output_id: null },
      },
      {
        source_input_id: f.input.inputId,
        attempt_index: 1,
        payload: { status: 'ok', assistant_output_ids: [output.id] },
      },
      { attempt_index: 0, payload: { status: 'ok' } },
    ]);
    expect(f.requests[2]!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: 'safe answer' }),
        expect.objectContaining({ content: 'configured repair' }),
      ]),
    );
  });

  it('accepts pinned plaintext without creating another turn', async () => {
    const f = fixture([() => refusal(), () => chatSuccess('accepted')]);
    await f.actor.turn(f.input, undefined, f.handoff);
    f.actor.abandonParkedTurn();
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.admission).toHaveBeenCalledTimes(1);
    expect(f.handoff.mock.calls[0]![0].input.routePass.kind).toBe('pinned-content-policy-retry');
  });

  it('settles a pinned terminal tool exactly once without continuation', async () => {
    const f = fixture([() => refusal(), toolResponse], true);
    const outcome = await f.actor.turn(f.input, undefined, f.handoff);
    if (outcome.type !== 'tool_call') throw new Error('Expected terminal probe.');
    f.actor.claimResultAndCloseContinuation(
      outcome,
      new Error('accepted terminal result'),
      () => undefined,
    );
    const settlement = executedNoneSettlement(toolSucceeded({ accepted: true }));
    await f.actor.settleToolResultWithoutContinuation(outcome.toolCallId, settlement);
    await expect(
      f.actor.settleToolResultWithoutContinuation(outcome.toolCallId, settlement),
    ).rejects.toThrow(/not waiting/);
    expect(f.rows().filter((row) => row.kind === 'tool_result')).toHaveLength(1);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.admission).toHaveBeenCalledTimes(1);
  });

  it('retains known pinned tool success during graceful cancellation without executing or continuing it', async () => {
    let entered!: () => void;
    let release!: (response: Response) => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const f = fixture([
      () => refusal(),
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          entered();
        }),
    ]);
    const pending = f.actor.turn(f.input, undefined, f.handoff);
    await started;
    f.actor.requestGracefulCancellation(new Error('controlled pinned interruption'));
    release(toolResponse());
    const outcome = await pending;
    if (outcome.type !== 'tool_call') throw new Error('Expected retained cancelled probe.');
    await expect(
      f.actor.appendToolResult(
        outcome.toolCallId,
        executedNoneSettlement(toolSucceeded({ forbidden: true })),
      ),
    ).rejects.toThrow(/admission is closed/);
    await f.actor.settleToolResultWithoutContinuation(
      outcome.toolCallId,
      syntheticToolSettlement('rejected_before_execution', 'cancelled before execution'),
    );
    expect(f.rows().filter((row) => row.kind === 'tool_call')).toHaveLength(1);
    expect(f.rows().filter((row) => row.kind === 'tool_result')).toHaveLength(1);
    expect(f.projection).toHaveBeenCalledTimes(1);
    expect(f.projection.mock.calls[0]![3]).toMatchObject([
      { attempt_index: 0, status: 'error' },
      { attempt_index: 1, status: 'ok' },
    ]);
    expect(
      readProviderExchangeEntries(f.root, f.input.sessionId).map((entry) => entry.data),
    ).toMatchObject([
      { source_input_id: f.input.inputId, attempt_index: 0, payload: { status: 'error' } },
      {
        source_input_id: f.input.inputId,
        attempt_index: 1,
        payload: {
          status: 'ok',
          assistant_output_ids: [`${f.input.inputId}:tool-call:probe-call`],
        },
      },
    ]);
    expect(readProviderExchangeEntries(f.root, f.input.sessionId)).toHaveLength(2);
    const result = f.rows().find((row) => row.kind === 'tool_result')!;
    expect(result.id).toBe(`${f.input.inputId}:tool-result:probe-call`);
    expect(result.content).toContain('cancelled before execution');
    expect(result.content).not.toContain('forbidden');
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.admission).toHaveBeenCalledTimes(1);
    expect(f.handoff).not.toHaveBeenCalled();
    await expect(f.actor.join()).resolves.toEqual({ status: 'joined' });
  });

  it.each(['refusal', 'non-policy'] as const)(
    'keeps pinned %s failure terminal without continuation',
    async (kind) => {
      const f = fixture([
        () => refusal('first refusal'),
        () =>
          kind === 'refusal'
            ? refusal('second refusal')
            : new Response(JSON.stringify({ error: { message: 'upstream timeout' } }), {
                status: 504,
                headers: { 'content-type': 'application/json' },
              }),
      ]);
      const outcome = await f.actor.turn(f.input, undefined, f.handoff);
      expect(outcome.type).toBe(kind === 'refusal' ? 'blocked' : 'error');
      expect(f.fetch).toHaveBeenCalledTimes(2);
      expect(f.admission).toHaveBeenCalledTimes(1);
      expect(f.projection).toHaveBeenCalledTimes(1);
      expect(f.projection.mock.calls[0]![3]).toMatchObject([
        { attempt_index: 0, status: 'error' },
        { attempt_index: 1, status: 'error' },
      ]);
      const markers = f.rows().filter((row) => row.kind === 'content_policy_refusal');
      expect(markers).toHaveLength(kind === 'refusal' ? 1 : 0);
      if (kind === 'refusal')
        expect(parseCanonicalContentPolicyRefusal(markers[0]!.content)).toMatchObject({
          source_input_id: f.input.inputId,
          candidate: FIRST,
          provider_response: expect.stringContaining('second refusal'),
        });
      expect(f.handoff.mock.calls[0]![0].input.routePass.kind).toBe('pinned-content-policy-retry');
      await expect(f.actor.continueAfterPlainText([], undefined, f.handoff)).rejects.toThrow(
        /no open plain-text result/,
      );
    },
  );

  it('terminates a real oversized pinned preflight before a second transport', async () => {
    const f = fixture([() => refusal()], false, 350);
    await expect(f.actor.turn(f.input, undefined, f.handoff)).resolves.toMatchObject({
      type: 'error',
    });
    expect(f.pinned).toHaveBeenCalledTimes(1);
    expect(f.pinned.mock.results[0]!.value).toMatchObject({
      kind: 'rejected',
      verdict: { kind: 'projection_too_large' },
    });
    expect(f.fetch).toHaveBeenCalledTimes(1);
    expect(f.admission).toHaveBeenCalledTimes(1);
    expect(f.projection).toHaveBeenCalledTimes(1);
    expect(f.projection.mock.calls[0]![3]).toMatchObject([{ attempt_index: 0, status: 'error' }]);
    expect(f.projection.mock.calls[0]![3]).toHaveLength(1);
    expect(f.handoff.mock.calls[0]![0].input.routePass.kind).toBe('pinned-content-policy-retry');
    expect(f.rows().filter((row) => row.kind === 'content_policy_refusal')).toHaveLength(0);
    await expect(f.actor.continueAfterPlainText([], undefined, f.handoff)).rejects.toThrow(
      /no open plain-text result/,
    );
  });
});

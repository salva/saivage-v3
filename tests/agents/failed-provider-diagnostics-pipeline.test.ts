import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { performance } from 'node:perf_hooks';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { FailedProviderRequestDiagnostics } from '../../src/agents/failed-provider-request-diagnostics.js';
import { MemoryCandidateAvailability } from '../../src/agents/candidate-availability.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { buildLlmOptions } from '../../src/agents/llm-options-factory.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import {
  createInvocationServiceProvider,
  executeInternalSummaryTurn,
} from '../../src/application/invocation-service-provider.js';
import { AdmittedProviderTurnFailure, NO_FRESHNESS_EFFECTS } from '../../src/contracts/index.js';
import { internalCompactionSummarySessionId } from '../../src/contracts/provider-exchange-log.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import {
  buildSummaryRequestInput,
  admitSummaryRequest,
  invokeSummaryRequest,
  type SummarizerProviderPort,
} from '../../src/runtime/actors/compaction/summarizer.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';
import { buildPreparedInvocationContext } from '../../src/runtime/actors/context/context-blocks.js';
import { RuntimeGate } from '../../src/runtime/runtime-gate.js';
import { agentMessageSchema } from '../../src/schemas/index.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { readProviderExchangeEntries } from '../../src/persistence/provider-exchange-log.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import {
  invocationProviderRegistry,
  chatSuccess,
  contextExhausted,
} from '../helpers/invocation-provider-fixture.js';
import {
  makeCodexJwt,
  testCompactor,
  unusedSummarizerProvider,
} from '../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { controlledResponse } from '../helpers/provider-inactivity.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { responsesProducerAccountId } from '../../src/agents/llm-openai-responses-account.js';
import {
  createSequentialRefineAccumulator,
  SUMMARY_REFINE_INSTRUCTION,
} from '../../src/runtime/actors/compaction/refine-accumulator.js';
import { validateConversation } from '../../src/contracts/conversation-validation.js';
import { noCompactionProgress } from '../helpers/executing-llm-snapshot.js';

const roots: string[] = [];
const servers: Server[] = [];
const candidate = { provider: 'test', account: null, model: 'model' };
const session = 'agent:planner:project' as const;
const inputId = '00000000-0000-4000-8000-000000000001';
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
function fixture(
  protocol: 'openai-chat-completions' | 'openai-codex-backend' | 'openai-responses',
  enabled = true,
  baseUrl?: string,
) {
  const selected =
    protocol === 'openai-codex-backend' ? { ...candidate, provider: 'openai-codex' } : candidate;
  const root = mkdtempSync('/home/salva/g/ml/tmp/failed-diagnostics-');
  roots.push(root);
  initProjectTree(root);
  const activation = randomUUID();
  const registry = invocationProviderRegistry(
    [selected],
    {
      [selected.provider]: {
        transportProtocol: protocol,
        contextWindowTokens: 100_000,
        maxOutputTokens: 10_000,
      },
    },
    {
      [selected.provider]:
        protocol === 'openai-codex-backend'
          ? makeCodexJwt('synthetic-account')
          : 'synthetic-test-key',
    },
    baseUrl ? { [selected.provider]: baseUrl } : {},
  );
  const service = new InvocationService({
    projectRoot: root,
    registry,
    candidateAvailability: new MemoryCandidateAvailability(),
    freshness: NO_FRESHNESS_EFFECTS,
    ...(enabled ? { failedProviderDiagnostics: activation } : {}),
  });
  const directory = join(root, '.saivage/diagnostics/failed-provider-requests', activation);
  return {
    root,
    registry,
    service,
    directory,
    candidate: selected,
    dumps: () =>
      existsSync(directory)
        ? readdirSync(directory)
            .filter((name) => name.endsWith('.json'))
            .map((name) => JSON.parse(readFileSync(join(directory, name), 'utf8')))
            .sort((a, b) => a.attempt_index - b.attempt_index)
        : [],
  };
}
beforeEach(() => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(async () => {
  jest.restoreAllMocks();
  jest.useRealTimers();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
function cyberFailure() {
  return new Response(
    `data: ${JSON.stringify({ type: 'response.failed', status: 403, response: { status: 'failed', error: { code: 'cyber_policy', message: 'synthetic terminal refusal' } } })}\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}
function refusal() {
  return new Response(
    JSON.stringify({ error: { code: 'content_filter', message: 'content policy refusal' } }),
    { status: 400 },
  );
}

describe('failed diagnostics through real invocation owners', () => {
  it('uses one service budget across distinct invocations and checks expiry at failure completion, not request start', async () => {
    let now = 0;
    jest.spyOn(performance, 'now').mockImplementation(() => now);
    const f = fixture('openai-chat-completions');
    const request = (source: 'agent:planner:project' | 'agent:analyst:global') => ({
      inputId: randomUUID(),
      agentName: 'planner',
      sessionId: source,
      systemPrompt: 'system',
      providerConversation: { sourceSessionId: source, messages: [] },
      tools: [],
      terminalToolNames: [],
      modelParams: { temperature: 0, maxTokens: 100 },
      capabilityRequest: {},
      routePass: { kind: 'pinned-content-policy-retry' as const, candidate },
    });
    const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => refusal());
    for (let index = 0; index < 17; index++) {
      const preflight = f.service.preflightPinnedContentPolicyRequest(
        request(index % 2 === 0 ? session : 'agent:analyst:global'),
      );
      if (preflight.kind !== 'admitted') throw new Error('must admit');
      await f.service
        .executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 })
        .catch(() => {});
    }
    expect(fetch).toHaveBeenCalledTimes(17);
    expect(f.dumps()).toHaveLength(16);
    expect(new Set(f.dumps().map((dump) => dump.source_session_id))).toEqual(
      new Set([session, 'agent:analyst:global']),
    );
    const expired = fixture('openai-chat-completions');
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    fetch.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    const preflight = expired.service.preflightPinnedContentPolicyRequest(request(session));
    if (preflight.kind !== 'admitted') throw new Error('must admit');
    const pending = expired.service
      .executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 })
      .catch((error) => error);
    await started;
    now = 3_600_000;
    release(refusal());
    expect((await pending).originalFailure.failure.kind).toBe('content_policy');
    expect(expired.dumps()).toEqual([]);
  });
  it.each([
    ['openai-chat-completions', false],
    ['openai-codex-backend', false],
    ['openai-responses', false],
    ['openai-chat-completions', true],
    ['openai-codex-backend', true],
    ['openai-responses', true],
  ] as const)(
    'projects real %s serialized tool history without changing submitted argument bytes (invalid=%s)',
    async (protocol, invalid) => {
      const f = fixture(protocol);
      const selected = f.candidate;
      const args = invalid
        ? '{"auth":{"value":"fixture-credential"'
        : JSON.stringify({
            auth: { value: 'fixture-credential' },
            rows: [{ config: { value: 'nested-config-credential' }, safe: 'quote " slash \\' }],
            ordered: [2, 1],
          });
      const content = JSON.stringify({ success: true, data: { text: 'ordinary tool result' } });
      const policy = toolRowPolicies({ content });
      const base = {
        session_id: session,
        round_id: 'r-assistant-00000000000000000000000000000000',
        message_index: 1,
        block_index: 0,
        timestamp: '2026-10-09T00:00:00.000Z',
        tool: 'fixture_tool',
        tool_call_id: 'call-fixture',
      };
      const messages = [
        agentMessageSchema.parse({
          ...base,
          id: `${inputId}:tool-call:call-fixture`,
          role: 'assistant',
          kind: 'tool_call',
          context_policy: policy.call,
          content: JSON.stringify({
            role: 'assistant',
            tool_calls: [
              {
                id: 'call-fixture',
                type: 'function',
                function: { name: 'fixture_tool', arguments: args },
              },
            ],
          }),
        }),
        agentMessageSchema.parse({
          ...base,
          id: `${inputId}:tool-result:call-fixture`,
          role: 'tool',
          kind: 'tool_result',
          context_policy: policy.result,
          content,
        }),
      ];
      if (protocol === 'openai-responses') {
        const privateId = `${inputId}:provider-private:openai-responses`;
        messages[0] = agentMessageSchema.parse({
          ...messages[0],
          provider_projection: {
            kind: 'openai_responses',
            source_input_id: inputId,
            private_message_id: privateId,
            projection_kind: 'assistant_tool_call',
          },
        });
        messages.unshift(
          agentMessageSchema.parse({
            session_id: session,
            id: privateId,
            role: 'system',
            kind: 'provider_private',
            context_policy: { kind: 'structural', behavior: 'responses_private' },
            round_id: base.round_id,
            message_index: 1,
            block_index: 0,
            timestamp: base.timestamp,
            content: JSON.stringify({
              transport: 'openai-responses',
              producer_account_id: responsesProducerAccountId(selected),
              source_input_id: inputId,
              projection_message_id: `${inputId}:tool-call:call-fixture`,
              provider: selected.provider,
              model: selected.model,
              output: [
                {
                  type: 'reasoning',
                  id: 'private-reasoning-id',
                  encrypted_content: 'private-encrypted-replay',
                },
                {
                  type: 'function_call',
                  id: 'private-native-reference',
                  call_id: 'call-fixture',
                  name: 'fixture_tool',
                  arguments: args,
                },
              ],
            }),
          }),
        );
      }
      let submitted = '';
      jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        submitted = String(init!.body);
        return refusal();
      });
      const preflight = f.service.preflightPinnedContentPolicyRequest({
        inputId,
        agentName: 'planner',
        sessionId: session,
        systemPrompt: 'system',
        providerConversation: { sourceSessionId: session, messages },
        tools: [],
        terminalToolNames: [],
        modelParams: { temperature: 0, maxTokens: 100 },
        capabilityRequest: {},
        routePass: { kind: 'pinned-content-policy-retry', candidate: selected },
      });
      if (preflight.kind !== 'admitted') throw new Error('must admit');
      await f.service
        .executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 })
        .catch(() => {});
      const raw = JSON.parse(submitted);
      const stored = JSON.parse(f.dumps()[0].stored_body);
      const rawArguments =
        protocol === 'openai-chat-completions'
          ? raw.messages.find((item: { tool_calls?: unknown }) => item.tool_calls).tool_calls[0]
              .function.arguments
          : raw.input.find((item: { type: string }) => item.type === 'function_call').arguments;
      const storedArguments =
        protocol === 'openai-chat-completions'
          ? stored.messages.find((item: { tool_calls?: unknown }) => item.tool_calls).tool_calls[0]
              .function.arguments
          : stored.input.find((item: { type: string }) => item.type === 'function_call').arguments;
      expect(rawArguments).toBe(args);
      expect(f.dumps()[0].raw_request_sha256).toBe(hash(submitted));
      if (invalid) {
        expect(storedArguments).toBe('[OMITTED_TOOL_ARGUMENTS]');
        expect(f.dumps()[0].counts.unprojectable_tool_arguments).toBe(1);
      } else
        expect(JSON.parse(storedArguments)).toEqual({
          auth: '[REDACTED]',
          rows: [{ config: '[OMITTED_PRIVATE_FIELD]', safe: 'quote " slash \\' }],
          ordered: [2, 1],
        });
      expect(JSON.stringify(f.dumps())).not.toContain('fixture-credential');
      expect(JSON.stringify(f.dumps())).not.toContain('nested-config-credential');
      if (protocol === 'openai-responses') {
        expect(submitted).toContain('private-encrypted-replay');
        expect(submitted).toContain('private-native-reference');
        expect(JSON.stringify(f.dumps())).not.toContain('private-encrypted-replay');
        expect(JSON.stringify(f.dumps())).not.toContain('private-native-reference');
        expect(f.dumps()[0].counts.private_replay).toBe(2);
      }
    },
  );
  it.each([
    ['http', 'openai-chat-completions', () => refusal(), 'content_policy', 400, 'content_filter'],
    [
      'codex terminal',
      'openai-codex-backend',
      () => cyberFailure(),
      'content_policy',
      200,
      'cyber_policy',
    ],
    [
      'Responses terminal',
      'openai-responses',
      () =>
        new Response(
          JSON.stringify({
            status: 'failed',
            error: { code: 'cyber_policy', message: 'synthetic terminal refusal' },
          }),
          { status: 200 },
        ),
      'content_policy',
      200,
      'cyber_policy',
    ],
    [
      'malformed stream',
      'openai-codex-backend',
      () => new Response('data: {invalid}\n\n', { status: 200 }),
      'parse_error',
      200,
      null,
    ],
    [
      'network',
      'openai-chat-completions',
      () => {
        throw new TypeError('synthetic network disconnected');
      },
      'unknown',
      null,
      null,
    ],
    [
      'nonstring provider code',
      'openai-chat-completions',
      () =>
        new Response(
          JSON.stringify({
            error: { code: ['cyber_policy'], message: 'synthetic server failure' },
          }),
          { status: 503 },
        ),
      'server_transient',
      503,
      null,
    ],
    [
      'code-like prose without structured code',
      'openai-chat-completions',
      () =>
        new Response(
          JSON.stringify({ error: { message: 'cyber_policy synthetic server failure' } }),
          { status: 503 },
        ),
      'server_transient',
      503,
      null,
    ],
  ] as const)(
    'observes %s through the shared executor without changing routing, bytes or failures',
    async (_name, protocol, respond, kind, status, code) => {
      const outcomes: unknown[] = [];
      const bodies: string[] = [];
      for (const enabled of [false, true]) {
        const f = fixture(protocol, enabled);
        const selected = f.candidate;
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          bodies.push(String(init!.body));
          return respond();
        });
        const preflight = f.service.preflightPinnedContentPolicyRequest({
          inputId,
          agentName: 'planner',
          sessionId: session,
          systemPrompt: 'system',
          providerConversation: { sourceSessionId: session, messages: [] },
          tools: [],
          terminalToolNames: [],
          modelParams: { temperature: 0, maxTokens: 100 },
          capabilityRequest: {},
          routePass: { kind: 'pinned-content-policy-retry', candidate: selected },
        });
        if (preflight.kind !== 'admitted') throw new Error('must admit');
        const failure = await f.service
          .executePinnedContentPolicyRequest(preflight, { attemptIndex: 2 })
          .catch((error) => error);
        expect(failure.originalFailure.failure.kind).toBe(kind);
        outcomes.push(failure.originalFailure.failure);
        if (enabled)
          expect(f.dumps()).toMatchObject([
            {
              attempt_index: 2,
              http_status: status,
              provider_code: code === null ? null : { value: code },
              raw_request_sha256: hash(bodies.at(-1)!),
            },
          ]);
        else expect(f.dumps()).toEqual([]);
        expect(fetch).toHaveBeenCalledTimes(1);
        fetch.mockRestore();
      }
      expect(outcomes[1]).toEqual(outcomes[0]);
      const normalized = bodies.map((body) => {
        const value = JSON.parse(body);
        delete value.prompt_cache_key;
        return value;
      });
      expect(normalized[1]).toEqual(normalized[0]);
    },
  );

  it('captures explicit Chat finish refusal once while returning the unchanged successful completion', async () => {
    const f = fixture('openai-chat-completions');
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { message: { content: 'unchanged refusal text' }, finish_reason: 'content_filter' },
          ],
        }),
        { status: 200 },
      ),
    );
    const preflight = f.service.preflightPinnedContentPolicyRequest({
      inputId,
      agentName: 'planner',
      sessionId: session,
      systemPrompt: 'system',
      providerConversation: { sourceSessionId: session, messages: [] },
      tools: [],
      terminalToolNames: [],
      modelParams: { temperature: 0, maxTokens: 100 },
      capabilityRequest: {},
      routePass: { kind: 'pinned-content-policy-retry', candidate },
    });
    if (preflight.kind !== 'admitted') throw new Error('must admit');
    await expect(
      f.service.executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 }),
    ).resolves.toMatchObject({
      result: { kind: 'message', content: 'unchanged refusal text' },
      provider_exchanges: [{ status: 'ok', finish_reason: 'content_filter' }],
    });
    expect(f.dumps()).toMatchObject([
      {
        observation: 'provider_refusal_finish_reason',
        failure_kind: 'content_filter',
        finish_reason: { value: 'content_filter' },
        provider_code: null,
        http_status: 200,
      },
    ]);
    expect(f.dumps()).toHaveLength(1);
  });

  it('observes Chat summary refusal once without changing downstream rejection or canonical success evidence', async () => {
    const f = fixture('openai-chat-completions');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            {
              message: { content: 'unchanged summary refusal' },
              finish_reason: 'content_filter',
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const input = buildSummaryRequestInput({
      candidate,
      sourceSessionId: session,
      instruction: 'Summarize supplied material',
      items: [{ label: '[kind=new_source]', role: 'user', content: 'synthetic summary material' }],
    });
    const capabilities = f.registry.getEffectiveCapabilities(candidate);
    const plan = buildCandidateRequest({
      candidate,
      capabilities,
      adapter: selectLlmProtocolAdapter(capabilities.transportProtocol),
      systemPrompt: input.systemPrompt,
      providerConversation: input.providerConversation,
      options: buildLlmOptions(
        input.agentName,
        [],
        [],
        { temperature: 0, max_tokens: 2000 },
        undefined,
        input.inputId,
        { projectRoot: f.root, sessionId: input.sessionId },
      ),
    });
    const admitted = admitSummaryRequest({
      serialization: {
        serializedRequest: plan.request.serializedBody,
        requestSha256: plan.request.requestHash,
        estimatedInputTokens: plan.request.estimatedWireInputTokens,
        imageCount: 0,
      },
      contextUtilizationFraction: 0.8,
      contextWindowTokens: 100_000,
      maxOutputTokens: 10_000,
    });
    if (admitted.kind !== 'admitted') throw new Error('must admit');
    const provider: SummarizerProviderPort = {
      candidate,
      contextWindowTokens: 100_000,
      maxOutputTokens: 10_000,
      materializeImage: async () => {
        throw new Error('no images');
      },
      serializeSummaryRequest: () => {
        throw new Error('already prepared');
      },
      completeTurn: (value, packed, signal) =>
        executeInternalSummaryTurn(f.service, value, signal, packed),
      projectProviderExchanges: (...args) => f.service.projectProviderExchanges(...args),
    };
    await expect(
      invokeSummaryRequest({
        input,
        admitted,
        summarizerProvider: provider,
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({
      originalFailure: {
        failure: {
          kind: 'content_policy',
          message: 'Summary provider refused the compaction request.',
        },
      },
      provider_exchanges: [{ status: 'ok', finish_reason: 'content_filter' }],
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.dumps()).toHaveLength(1);
    expect(f.dumps()[0]).toMatchObject({
      purpose: 'internal-summary',
      source_session_id: session,
      input_id: input.inputId,
      provider_code: null,
      observation: 'provider_refusal_finish_reason',
      raw_request_sha256: hash(String(fetch.mock.calls[0]![1]!.body)),
    });
    expect(readProviderExchangeEntries(f.root, session)[0]!.data).toMatchObject({
      session_id: input.sessionId,
      source_input_id: input.inputId,
      payload: { status: 'ok', finish_reason: 'content_filter' },
    });
  });

  it.each(['stream cancellation', 'inactivity', 'classified then cancellation'] as const)(
    'handles %s without recapture or cancellation masking',
    async (mode) => {
      jest.useFakeTimers();
      const f = fixture('openai-chat-completions');
      const controller = new AbortController();
      let stream: ReturnType<typeof controlledResponse> | undefined;
      const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        if (mode === 'classified then cancellation') return refusal();
        stream = controlledResponse(init!.signal!);
        return stream.response;
      });
      const preflight = f.service.preflightPinnedContentPolicyRequest({
        inputId,
        agentName: 'planner',
        sessionId: session,
        systemPrompt: 'system',
        providerConversation: { sourceSessionId: session, messages: [] },
        tools: [],
        terminalToolNames: [],
        modelParams: { temperature: 0, maxTokens: 100 },
        capabilityRequest: {},
        routePass: { kind: 'pinned-content-policy-retry', candidate },
      });
      if (preflight.kind !== 'admitted') throw new Error('must admit');
      if (mode === 'classified then cancellation') {
        const classify = preflight.plan.adapter.classifyHttpFailure;
        preflight.plan.adapter = {
          ...preflight.plan.adapter,
          classifyHttpFailure: (...args) => {
            const failure = classify(...args);
            controller.abort(new Error('stopped after classification'));
            return failure;
          },
        };
      }
      const pending = f.service
        .executePinnedContentPolicyRequest(preflight, { attemptIndex: 0 }, controller.signal)
        .catch((error) => error);
      await jest.advanceTimersByTimeAsync(0);
      if (mode === 'stream cancellation') controller.abort(new Error('owner stopped'));
      if (mode === 'inactivity') await jest.advanceTimersByTimeAsync(120_000);
      const outcome = await pending;
      if (mode === 'inactivity') {
        expect(outcome.originalFailure.failure.kind).toBe('timeout');
        expect(f.dumps()).toMatchObject([
          { failure_kind: 'timeout', http_status: 200, provider_code: null },
        ]);
      } else expect(f.dumps()).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      stream?.close();
      expect(jest.getTimerCount()).toBe(0);
    },
  );
  it('retains ordinary diagnostic offsets across real context-recovery suspension and resume', async () => {
    const f = fixture('openai-chat-completions');
    const submitted: string[] = [];
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      submitted.push(String(init!.body));
      return submitted.length === 1 ? contextExhausted() : refusal();
    });
    const preparedCompaction = prepareCompaction(
      {
        context_utilization_fraction: 0.8,
        trigger_fraction: 0.8,
        tail_fraction: 0.25,
        snap: 'compact_straddler',
      },
      'system',
      [],
      8000,
      2000,
    );
    const message = (content: string) =>
      agentMessageSchema.parse({
        id: 'source',
        session_id: session,
        role: 'user',
        kind: 'text',
        content,
        context_policy: {
          kind: 'content',
          storage: 'durable',
          replacement: { kind: 'retain' },
          audience: 'primary_and_summarizer',
          evidence: { kind: 'none' },
          compactable: true,
        },
        round_id: 'r-pre-00000000000000000000000000000000',
        message_index: 0,
        block_index: 0,
        timestamp: '2026-10-09T00:00:00.000Z',
      });
    const request = {
      inputId,
      agentName: 'planner',
      sessionId: session,
      systemPrompt: 'system',
      providerConversation: {
        sourceSessionId: session,
        messages: [message('long context '.repeat(1000))],
      },
      tools: [],
      terminalToolNames: [],
      modelParams: { temperature: 0 },
      preparedCompaction,
      preparedContext: buildPreparedInvocationContext({
        instructionText: 'system',
        terminalToolNames: [],
        compiledTools: [],
        dynamicBlocks: [],
        preparedCompaction,
      }),
      capabilityRequest: {},
      routePass: { kind: 'ordinary' as const, candidateChain: [candidate] },
    };
    const admission = f.service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('must admit');
    const first = await f.service.executeAdmittedWithRecovery(admission).catch((error) => error);
    expect(first).toBeInstanceOf(AdmittedProviderTurnFailure);
    const recovery = f.service.prepareAdmittedRecovery({
      suspension: first.suspension,
      request: {
        ...request,
        providerConversation: { sourceSessionId: session, messages: [message('compact summary')] },
      },
    });
    const failure = await f.service.resumeAdmittedExecution(recovery).catch((error) => error);
    expect(
      failure.provider_exchanges.map((attempt: { attempt_index: number }) => attempt.attempt_index),
    ).toEqual([0, 1]);
    expect(
      f.dumps().map((dump) => [dump.input_id, dump.attempt_index, dump.raw_request_sha256]),
    ).toEqual(submitted.map((body, index) => [inputId, index, hash(body)]));
    expect(submitted).toHaveLength(2);
  });
  it('captures the actual prepared Codex summary, not a reconstructed conversation or refusal marker', async () => {
    const submitted: string[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      submitted.push(Buffer.concat(chunks).toString('utf8'));
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(await cyberFailure().text());
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const f = fixture(
      'openai-codex-backend',
      true,
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    );
    const candidate = f.candidate;
    const timestamp = '2026-10-09T00:00:00.000Z';
    const common = {
      session_id: session,
      round_id: 'r-assistant-00000000000000000000000000000000',
      message_index: 0,
      block_index: 0,
      timestamp,
    };
    const text = (id: string, role: 'user' | 'assistant' | 'system', content: string) =>
      agentMessageSchema.parse({
        ...common,
        id,
        role,
        kind: 'text',
        content,
        context_policy: {
          kind: 'content',
          storage: 'durable',
          replacement: { kind: 'retain' },
          audience: 'primary_and_summarizer',
          evidence: { kind: 'none' },
          compactable: true,
        },
      });
    const rows = [
      agentMessageSchema.parse({
        ...common,
        id: 'activation',
        role: 'system',
        kind: 'activity',
        context_policy: { kind: 'structural', behavior: 'activation_boundary' },
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'planner',
          card_id: 'project',
          input_id: inputId,
          timestamp,
        }),
      }),
      text('batch-one', 'user', 'First labeled batch'),
      text('batch-two', 'assistant', 'Second labeled batch'),
    ];
    const protectedMessage = agentMessageSchema.parse({
      ...text('retained-instruction', 'user', 'Protected instruction text'),
      context_policy: {
        kind: 'content',
        storage: 'durable',
        replacement: { kind: 'retain' },
        audience: 'primary_and_summarizer',
        evidence: { kind: 'none' },
        compactable: false,
        compaction_key: 'retained-instruction',
      },
    });
    let input!: Parameters<SummarizerProviderPort['completeTurn']>[0];
    let admitted!: Parameters<SummarizerProviderPort['completeTurn']>[1];
    const capabilities = f.registry.getEffectiveCapabilities(candidate);
    const provider: SummarizerProviderPort = {
      candidate,
      contextWindowTokens: 100_000,
      maxOutputTokens: 10_000,
      materializeImage: async () => {
        throw new Error('no images');
      },
      serializeSummaryRequest: (value) => {
        const plan = buildCandidateRequest({
          candidate,
          capabilities,
          adapter: selectLlmProtocolAdapter(capabilities.transportProtocol),
          systemPrompt: value.systemPrompt,
          providerConversation: value.providerConversation,
          options: buildLlmOptions(
            value.agentName,
            [],
            [],
            { temperature: 0, max_tokens: 2000 },
            undefined,
            value.inputId,
            { projectRoot: f.root, sessionId: value.sessionId },
          ),
        });
        return {
          serializedRequest: plan.request.serializedBody,
          requestSha256: plan.request.requestHash,
          estimatedInputTokens: plan.request.estimatedWireInputTokens,
          imageCount: plan.request.imageCount,
        };
      },
      completeTurn: (value, packed, signal) => {
        input = value;
        admitted = packed;
        return executeInternalSummaryTurn(f.service, value, signal, packed);
      },
      projectProviderExchanges: (...args) => f.service.projectProviderExchanges(...args),
    };
    const accumulator = createSequentialRefineAccumulator({
      conversation: validateConversation(session, rows),
      inheritedHistory: {
        summaryText: 'Inherited summary text',
        protectedPrompts: [],
        requiredModelFacts: { latestRecovery: null, latestContentPolicyRefusal: null },
      },
      preparedBlocks: [
        {
          id: 'prepared.orientation',
          role: 'system',
          content: 'Prepared context text',
          storage: 'activation_local',
          replacement: {
            kind: 'latest_snapshot',
            key: 'prepared.orientation',
            contentSha256: hash('Prepared context text'),
          },
          audience: 'primary_and_summarizer',
          evidence: { kind: 'none' },
        },
      ],
      protectedPrompts: [{ source: { segmentVersion: 1, rowIndex: 1 }, message: protectedMessage }],
      summarizerProvider: provider,
      budget: { contextUtilizationFraction: 0.8 },
      signal: new AbortController().signal,
      progress: noCompactionProgress,
    });
    await expect(accumulator.materializeThrough(rows.length)).rejects.toMatchObject({
      originalFailure: { failure: { kind: 'content_policy' } },
    });
    expect(submitted).toEqual([admitted.serializedRequest]);
    const [dump] = f.dumps();
    expect(f.dumps()).toHaveLength(1);
    const projectedBody = JSON.stringify({
      ...JSON.parse(submitted[0]!),
      prompt_cache_key: '[REDACTED]',
    });
    expect(dump).toMatchObject({
      source_session_id: session,
      invocation_session_id: internalCompactionSummarySessionId(session),
      input_id: input.inputId,
      purpose: 'internal-summary',
      attempt_index: 0,
      http_status: 200,
      embedded_status: 403,
      provider_code: { value: 'cyber_policy' },
      raw_request_sha256: hash(submitted[0]!),
      body_disposition: 'redacted',
      stored_body: projectedBody,
      stored_body_sha256: hash(projectedBody),
    });
    const body = JSON.parse(dump.stored_body);
    expect(body.instructions).toBe(SUMMARY_REFINE_INSTRUCTION);
    expect(body.tools).toBeUndefined();
    const material = body.input.map((item: { content: string | { text: string }[] }) =>
      typeof item.content === 'string'
        ? item.content
        : item.content.map((part) => part.text).join(''),
    );
    expect(material).toEqual(input.providerConversation.messages.map((message) => message.content));
    const all = material.join('\n');
    for (const value of [
      '[kind=prepared_context source=prepared.orientation]',
      'Prepared context text',
      '[kind=protected_instruction source=1:1:retained-instruction]',
      'Protected instruction text',
      'Inherited summary text',
      'First labeled batch',
      'Second labeled batch',
    ])
      expect(all).toContain(value);
    expect(all.indexOf('First labeled batch')).toBeLessThan(all.indexOf('Second labeled batch'));
    expect(
      material.every((value: string, index: number) =>
        value.startsWith(`[order ${index + 1}/${material.length}] `),
      ),
    ).toBe(true);
    expect(readProviderExchangeEntries(f.root, session).map((entry) => entry.data)).toMatchObject([
      { source_input_id: input.inputId, attempt_index: 0 },
    ]);
  });

  it.each([false, true])(
    'correlates actor-combined pinned indexes after transient=%s and preserves disabled call counts',
    async (transient) => {
      const counts: number[] = [];
      const bodies: string[][] = [];
      for (const enabled of [false, true]) {
        if (transient) jest.useFakeTimers();
        const f = fixture('openai-chat-completions', enabled);
        const submitted: string[] = [];
        bodies.push(submitted);
        const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
          submitted.push(String(init!.body));
          return transient && submitted.length === 1
            ? new Response('{"error":{"message":"try again"}}', { status: 503 })
            : refusal();
        });
        appendConversationBatch({ projectRoot: f.root }, [
          agentMessageSchema.parse({
            id: 'activation',
            session_id: session,
            role: 'system',
            kind: 'activity',
            content: JSON.stringify({
              event: 'activation_open',
              agent_name: 'planner',
              card_id: 'project',
              input_id: inputId,
              timestamp: '2026-10-09T00:00:00.000Z',
            }),
            context_policy: { kind: 'structural', behavior: 'activation_boundary' },
            round_id: 'r-pre-00000000000000000000000000000000',
            message_index: 0,
            block_index: 0,
            timestamp: '2026-10-09T00:00:00.000Z',
          }),
        ]);
        const preparedCompaction = prepareCompaction(
          {
            context_utilization_fraction: 0.8,
            trigger_fraction: 0.8,
            tail_fraction: 0.25,
            snap: 'compact_straddler',
          },
          'system',
          [],
          8000,
          2000,
        );
        const actor = new ConversationLLMActor({
          provider: createInvocationServiceProvider(f.service, f.root),
          conversations: { projectRoot: f.root },
          compactor: testCompactor,
          summarizerProvider: unusedSummarizerProvider,
          fatalPort: testApplicationFatalPort,
          agentId: session,
          purpose: { kind: 'autonomous-card', cardId: 'project' },
          gate: new RuntimeGate(),
        });
        const pending = actor.turn(
          {
            inputId,
            agentId: session,
            agentName: 'planner',
            sessionId: session,
            systemPrompt: 'system',
            providerConversation: { sourceSessionId: session, messages: [] },
            tools: [],
            compiledToolContracts: [],
            terminalToolNames: [],
            modelParams: { temperature: 0 },
            preparedCompaction,
            preparedContext: buildPreparedInvocationContext({
              instructionText: 'system',
              terminalToolNames: [],
              compiledTools: [],
              dynamicBlocks: [],
              preparedCompaction,
            }),
            capabilityRequest: {},
            routePass: { kind: 'ordinary', candidateChain: [candidate] },
            episodeContext: {},
          },
          undefined,
          () => {},
        );
        if (transient) await jest.advanceTimersByTimeAsync(60_000);
        await expect(pending).resolves.toMatchObject({
          type: 'blocked',
          result: { kind: 'content-policy-refusal' },
        });
        const entries = readProviderExchangeEntries(f.root, session).map((entry) => entry.data);
        expect(entries.map((entry) => entry.attempt_index)).toEqual(transient ? [0, 1, 2] : [0, 1]);
        if (enabled) {
          expect(
            f.dumps().map((dump) => [dump.source_session_id, dump.input_id, dump.attempt_index]),
          ).toEqual(entries.map((entry) => [session, entry.source_input_id, entry.attempt_index]));
          expect(f.dumps().map((dump) => dump.raw_request_sha256)).toEqual(submitted.map(hash));
        } else {
          expect(f.dumps()).toEqual([]);
          expect(existsSync(join(f.root, '.saivage/diagnostics'))).toBe(false);
        }
        counts.push(fetch.mock.calls.length);
        fetch.mockRestore();
        jest.useRealTimers();
      }
      expect(counts).toEqual(transient ? [3, 3] : [2, 2]);
      // Provider session affinity is deliberately fresh per owner; all model content/routing stays identical.
      expect(bodies[0]!.map((body) => JSON.parse(body))).toEqual(
        bodies[1]!.map((body) => JSON.parse(body)),
      );
    },
  );

  it('does not capture success, rejected pinned preflight, or pre-transport cancellation', async () => {
    const capture = jest.spyOn(FailedProviderRequestDiagnostics.prototype, 'capture');
    const f = fixture('openai-chat-completions');
    const fetch = jest.spyOn(globalThis, 'fetch').mockResolvedValue(chatSuccess('ok'));
    const request = {
      inputId,
      agentName: 'planner',
      sessionId: session,
      systemPrompt: 'system',
      providerConversation: { sourceSessionId: session, messages: [] },
      tools: [],
      terminalToolNames: [],
      modelParams: { temperature: 0, maxTokens: 100 },
      capabilityRequest: {},
      routePass: { kind: 'ordinary' as const, candidateChain: [candidate] },
    };
    const admission = f.service.preparePrimaryRequestAdmission(request);
    if (admission.kind !== 'admitted') throw new Error('must admit');
    await f.service.executeAdmittedWithRecovery(admission);
    expect(
      f.service.preflightPinnedContentPolicyRequest({
        ...request,
        systemPrompt: 'x'.repeat(500_000),
        routePass: { kind: 'pinned-content-policy-retry', candidate },
      }).kind,
    ).toBe('rejected');
    const abort = new AbortController();
    abort.abort(new Error('stopped'));
    await expect(
      f.service.executeAdmittedWithRecovery(admission, abort.signal),
    ).rejects.toBeDefined();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.dumps()).toEqual([]);
    expect(capture).not.toHaveBeenCalled();
  });
});

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { chatOperatorApiContracts } from '../../src/contracts/operator-api-chats.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createEventLog } from '../../src/observability/index.js';
import { projectLiveToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import {
  OUTBOUND_IDENTITY,
  OUTBOUND_RAW_MARKER,
  OUTBOUND_TEXT_MARKER,
} from '../helpers/outbound-identity-fixtures.js';
import { projectAnalystToolInvocationActivity } from '../../src/server/tool-activity-projection.js';
import { globalObservationToolBinders, type GlobalObservationToolContext } from '../../src/tools/global-observation-tools.js';
import { AnalystTurnBusyError } from '../../src/agents/analyst-api.js';
import { AnalystWsHandler } from '../../src/server/analyst-ws-handler.js';
import type { WebSocket } from 'ws';
import { toolFailed } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { canonicalJson } from '../../src/schemas/index.js';

describe('operator chat route request contracts', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  const submit = jest.fn<RuntimeApplication['analystRuntime']['submit']>(async () => ({
    sessionId: 'agent:analyst:global',
    toolInvocations: [],
    restart: null,
  }));
  const acknowledge = jest.fn(async () => undefined);
  const authHeaders = { authorization: 'Bearer route-token' };

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-chat-routes-'));
    initProjectTree(projectRoot);
    submit.mockClear();
    acknowledge.mockClear();
    fastify = Fastify({ logger: false });
    const handlers = buildChatOperatorContractHandlers({
      projectRoot,
      runtimeApplication: {
        analystRuntime: { submit },
        analystSessionId: 'agent:analyst:global',
        cardStore: new CardService(projectRoot),
      } as unknown as RuntimeApplication,
      saivageConfig: TEST_SAIVAGE_CONFIG,
      restartCapability: { available: true, port: { schedule: jest.fn(), acknowledge } },
    });
    new ContractRuntime({
      authPolicy: new AuthPolicy({ apiToken: 'route-token' }),
      eventLogger: createEventLog(projectRoot),
      fatalPort: testApplicationFatalPort,
    }).mount(fastify, chatOperatorApiContracts, handlers);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('admits canonical GET and returns only the Analyst identity', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/chat',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session_id: 'agent:analyst:global' });
  });

  it('leaves the removed aggregate chat URL to ordinary Fastify not-found handling', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/chats',
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Not Found', statusCode: 404 });
  });

  it('admits canonical POST and submits the Analyst turn', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toolInvocations: [],
      restart: null,
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      userContent: 'hello',
      workspaceContext: undefined,
    });
  });

  it('publishes the exact settled durable result through REST while projecting parameters only', async () => {
    const settled = settleToolActionOutcome(toolFailed('denied token=sk-a', { code: 'record_mutation_denied', detail: 'sk-a', formerly_narrowed: true }));
    submit.mockResolvedValueOnce({
      sessionId: 'agent:analyst:global',
      toolInvocations: [{
        tool: 'write',
        params: { path: 'record:///brief.md?card=project', content: `token=${OUTBOUND_RAW_MARKER}` },
        result: settled.providerResult,
        sourceInputId: '11111111-1111-4111-8111-111111111111',
        toolCallId: 'call-rest-settled',
      }],
      restart: null,
    });

    const response = await fastify.inject({ method: 'POST', url: '/api/chat', headers: authHeaders, payload: { content: 'write' } });
    const invocation = (response.json() as { toolInvocations: Array<{ params: unknown; result: unknown }> }).toolInvocations[0]!;

    expect(response.statusCode).toBe(200);
    expect(canonicalJson(invocation.result)).toBe(settled.settledResultBytes);
    expect(invocation.result).toEqual(settled.providerResult);
    expect(JSON.stringify(invocation.params)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it.each([
    {
      label: 'settled valid',
      invocation: {
        tool: 'run_command',
        params: { command: `TOKEN=${OUTBOUND_RAW_MARKER} npm test` },
        result: {
          success: true as const,
          data: {
            process_id: 'proc-0123456789ab',
            exit_code: 0,
            status: 'exited',
            stdout: 'ok',
            stderr: '',
            stdout_complete: true,
            stderr_complete: true,
            stdout_url: 'work:///processes/proc-0123456789ab/stdout.log',
            stderr_url: 'work:///processes/proc-0123456789ab/stderr.log',
            stdout_bytes: 1,
            stderr_bytes: 2,
          },
        },
      },
    },
    {
      label: 'settled valid webfetch',
      invocation: {
        tool: 'webfetch',
        params: {
          url: `https://example.test/path?token=${OUTBOUND_RAW_MARKER}#fragment`,
          read_mode: 'text',
          metadata_only: false,
          max_bytes: 123,
          max_inline_bytes: 45,
        },
        result: {
          success: true as const,
          data: { kind: 'text', redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, head: 'stable head', head_utf8_bytes: 11, redacted_text_utf8_bytes: 11, fetched_text_utf8_bytes: 11, head_complete: true, fetch_truncated: false },
        },
      },
    },
    {
      label: 'unsupported',
      invocation: {
        tool: 'unsupported_tok_primary',
        params: { apiKey: OUTBOUND_RAW_MARKER },
        result: { success: false as const, error: 'token=[REDACTED]' },
      },
    },
    {
      label: 'schema-invalid known',
      invocation: {
        tool: 'webfetch',
        params: { url: 7, apiKey: OUTBOUND_RAW_MARKER },
        result: { success: false as const, error: 'token=[REDACTED]' },
      },
    },
    {
      label: 'settled malformed-JSON protocol',
      invocation: {
        tool: 'webfetch',
        params: {},
        result: {
          success: false as const,
          error: 'Tool arguments must be valid JSON: sk-[REDACTED]',
        },
      },
    },
  ])(
    'projects a $label completed invocation before chats.send publication',
    async ({ invocation }) => {
      submit.mockResolvedValueOnce({
        sessionId: 'agent:analyst:global',
        toolInvocations: [
          {
            ...invocation,
            sourceInputId: '11111111-1111-4111-8111-111111111111',
            toolCallId: 'call-tok_primary',
          },
        ],
        restart: null,
      });

      const response = await fastify.inject({
        method: 'POST',
        url: '/api/chat',
        headers: authHeaders,
        payload: { content: 'invoke' },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        toolInvocations: Array<{ tool: string; params: unknown; result: unknown }>;
      };
      expect(body.toolInvocations).toHaveLength(1);
      const projected = projectLiveToolInvocation({
        shape: 'complete',
        identity: {
          sessionId: 'agent:analyst:global',
          sourceInputId: '11111111-1111-4111-8111-111111111111',
          toolCallId: 'call-tok_primary',
          toolName: invocation.tool,
        },
        arguments: invocation.params,
        result: invocation.result,
      });
      expect(body.toolInvocations[0]).toEqual({
        tool: projected.identity.toolName,
        params: projected.arguments,
        result: projected.result,
      });
      expect(response.body).not.toContain(OUTBOUND_RAW_MARKER);
      expect(response.body).not.toContain('sourceInputId');
      expect(response.body).not.toContain('toolCallId');
    },
  );

  it('publishes one settled invocation identically through chat, WebSocket, Agent, and bounded session paths', async () => {
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    const toolCallId = 'call-tok_primary';
    const timestamp = '2026-07-22T10:00:00.000Z';
    const invocation = {
      tool: 'run_command',
      params: { command: `TOKEN=${OUTBOUND_RAW_MARKER} npm test` },
      result: {
        success: true as const,
        data: {
          process_id: 'proc-0123456789ab',
          exit_code: 0,
          status: 'exited',
          stdout: 'ok',
          stderr: '',
          stdout_complete: true,
          stderr_complete: true,
          stdout_url: 'work:///processes/proc-0123456789ab/stdout.log',
          stderr_url: 'work:///processes/proc-0123456789ab/stderr.log',
          stdout_bytes: 1,
          stderr_bytes: 2,
        },
      },
      sourceInputId,
      toolCallId,
    };
    submit.mockResolvedValueOnce({
      sessionId: 'agent:analyst:global',
      toolInvocations: [invocation],
      restart: null,
    });
    const sent = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'invoke' },
    });
    const chatInvocation = (
      sent.json() as { toolInvocations: Array<{ tool: string; params: unknown; result: unknown }> }
    ).toolInvocations[0]!;

    appendConversationBatch(
      { projectRoot },
      buildAnalystIngressRows('agent:analyst:global', sourceInputId, 'workspace', 'invoke'),
    );
    appendConversationBatch({ projectRoot }, [
      {
        id: `${sourceInputId}:tool-call:${toolCallId}`,
        session_id: 'agent:analyst:global',
        role: 'assistant',
        kind: 'tool_call',
        tool: invocation.tool,
        tool_call_id: toolCallId,
        context_policy: toolRowPolicies({ content: '' }).call,
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            {
              id: toolCallId,
              type: 'function',
              function: { name: invocation.tool, arguments: JSON.stringify(invocation.params) },
            },
          ],
        }),
        round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
        message_index: 3,
        block_index: 0,
        timestamp,
      },
      {
        id: `${sourceInputId}:tool-result:${toolCallId}`,
        session_id: 'agent:analyst:global',
        role: 'tool',
        kind: 'tool_result',
        tool: invocation.tool,
        tool_call_id: toolCallId,
        context_policy: toolRowPolicies({ content: JSON.stringify(invocation.result) }).result,
        content: JSON.stringify(invocation.result),
        round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
        message_index: 4,
        block_index: 0,
        timestamp,
      },
    ]);

    const agentResult = new AgentOperatorReadModelService(
      projectRoot,
      TEST_WORKFLOWS,
       () => new Map(),
    ).getConversation('agent:analyst:global');
    const agentRows = agentResult.entries.slice(-2);
    const got = await fastify.inject({ method: 'GET', url: '/api/chat', headers: authHeaders });
    expect(got.json()).toEqual({ session_id: 'agent:analyst:global' });

    const binder = globalObservationToolBinders.find((candidate) => candidate.name === 'read_agent_session');
    if (!binder) throw new Error('Expected production read_agent_session binder.');
    const tool = binder.bind({
        projectRoot,
        store: new CardService(projectRoot),
        captureExecutingLlmSnapshots: () => new Map(),
      } as unknown as GlobalObservationToolContext);
    const bounded = (await tool.executor(tool.inputSchema.parse({ session_id: 'agent:analyst:global', last_n: 2 }), new AbortController().signal)).providerOutcome;
    if (bounded.kind !== 'succeeded') throw new Error(bounded.error);
    expect((bounded.data as { messages: { items: unknown[] } }).messages.items).toEqual(agentRows);

    const callArguments = JSON.parse(
      JSON.parse(agentRows[0]!.content).tool_calls[0].function.arguments,
    );
    const result = JSON.parse(agentRows[1]!.content);
    expect({ tool: agentRows[0]!.tool, params: callArguments, result }).toEqual(chatInvocation);
    const activity = projectAnalystToolInvocationActivity(invocation, 'agent:analyst:global');
    expect({ tool: activity.tool, params: activity.params, result: activity.result }).toEqual(
      chatInvocation,
    );
    expect(JSON.stringify({ chatInvocation, agentRows, bounded, activity })).not.toContain(
      OUTBOUND_RAW_MARKER,
    );
  });

  it.each([
    {},
    { content: '' },
    { content: 'hello', unexpected: true },
    { content: 'hello', workspaceContext: { view: null, entityId: null, refinement: null, unexpected: true } },
  ])('rejects invalid body %j through runtime validation', async (payload) => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError', message: expect.any(String), issues: expect.any(Array) });
    expect(submit).not.toHaveBeenCalled();
  });

  it('lets an unexpected Analyst submission failure reach the strict contract boundary', async () => {
    const marker = 'hostile-chat-submit-token';
    submit.mockRejectedValueOnce(
      Object.assign(new Error(`message-${marker}`), {
        token: marker,
        path: `/secret/${marker}`,
        cause: { marker },
      }),
    );

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      error: 'InternalServerError',
      message: 'Internal server error',
    });
    expect(response.body).not.toContain(marker);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('maps only typed Analyst overlap to the exact content-free 409 contract', async () => {
    submit.mockRejectedValueOnce(new AnalystTurnBusyError());
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'overlap' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      error: 'analyst_turn_busy',
      message: 'Another Analyst turn is active. Retry after it finishes.',
    });
  });

  it('shares immediate one-winner admission across REST and WebSocket without later queued execution', async () => {
    let release!: (value: { sessionId: 'agent:analyst:global'; toolInvocations: []; restart: null }) => void;
    const active = new Promise<{ sessionId: 'agent:analyst:global'; toolInvocations: []; restart: null }>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let submissions = 0;
    submit.mockImplementation(() => {
      submissions += 1;
      if (submissions === 1) { markStarted(); return active; }
      return Promise.reject(new AnalystTurnBusyError());
    });
    const restWinner = fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'rest winner' },
    }).then((response) => response);
    await started;

    const sendToClient = jest.fn();
    const wsHandler = new AnalystWsHandler({
      fatalPort: testApplicationFatalPort,
      restartCapability: { available: false },
      liveSyncSocket: { handleClientFrame: () => false } as never,
      runtimeApplication: { analystSessionId: 'agent:analyst:global', analystRuntime: { submit } } as never,
      sendToClient,
    });
    const ws = { OPEN: 1, readyState: 1 } as WebSocket;
    await wsHandler.handleRawMessage(ws, Buffer.from(JSON.stringify({ type: 'message', content: { text: 'ws loser' } })), { error() {} });
    expect(sendToClient).toHaveBeenCalledWith(ws, {
      type: 'error',
      content: { error: 'analyst_turn_busy', message: 'Another Analyst turn is active. Retry after it finishes.' },
    });

    release({ sessionId: 'agent:analyst:global', toolInvocations: [], restart: null });
    expect((await restWinner).statusCode).toBe(200);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('returns an immediate typed loser for overlapping REST callers without later execution', async () => {
    let release!: (value: { sessionId: 'agent:analyst:global'; toolInvocations: []; restart: null }) => void;
    const active = new Promise<{ sessionId: 'agent:analyst:global'; toolInvocations: []; restart: null }>((resolve) => { release = resolve; });
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    let submissions = 0;
    submit.mockImplementation(() => {
      submissions += 1;
      if (submissions === 1) { markStarted(); return active; }
      return Promise.reject(new AnalystTurnBusyError());
    });
    const winner = fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'winner' },
    }).then((response) => response);
    await started;

    const loser = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'loser' },
    });

    expect(loser.statusCode).toBe(409);
    expect(loser.json()).toEqual({
      error: 'analyst_turn_busy',
      message: 'Another Analyst turn is active. Retry after it finishes.',
    });
    release({ sessionId: 'agent:analyst:global', toolInvocations: [], restart: null });
    expect((await winner).statusCode).toBe(200);
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('rejects malformed workspace context before Analyst submission', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: {
        content: 'hello',
        workspaceContext: { view: 1, entityId: null, refinement: null },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('acknowledges a scheduled restart after the reply finishes', async () => {
    submit.mockResolvedValueOnce({
      sessionId: 'agent:analyst:global',
      toolInvocations: [],
      restart: { status: 'scheduled' },
    });

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chat',
      headers: authHeaders,
      payload: { content: 'restart' },
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      toolInvocations: [],
      restart: { status: 'scheduled' },
    });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('does not advertise a production-impossible 503 response', () => {
    expect(chatOperatorApiContracts['chats.send'].response).not.toHaveProperty('503');
  });

  it('keeps GET identity-only when the durable transcript ends in an unmatched call', async () => {
    const inputId = '11111111-1111-4111-8111-111111111111';
    const ingress = buildAnalystIngressRows(
      'agent:analyst:global',
      inputId,
      'workspace',
      'question',
    );
    appendConversationBatch({ projectRoot }, ingress);
    appendConversationBatch({ projectRoot }, [
      {
        id: `${inputId}:tool-call:call-1`,
        session_id: 'agent:analyst:global',
        role: 'assistant',
        kind: 'tool_call',
        tool: 'webfetch',
        tool_call_id: 'call-1',
        context_policy: toolRowPolicies({ content: '' }).call,
        content: JSON.stringify({
          role: 'assistant',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' },
            },
          ],
        }),
        round_id: `r-assistant-${inputId.replaceAll('-', '')}`,
        message_index: 3,
        block_index: 0,
        timestamp: ingress[2].timestamp,
      },
    ]);
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/chat',
      headers: authHeaders,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session_id: 'agent:analyst:global' });
  });

  it('leaves unrelated unmatched URLs to Fastify not-found handling', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/not-a-chat-route',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(404);
  });
});

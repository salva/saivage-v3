import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { chatOperatorApiContracts } from '../../src/contracts/operator-api-chats.js';
import type { RuntimeApplication } from '../../src/application/runtime-composition.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createEventLog } from '../../src/observability/index.js';

describe('operator chat route request contracts', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  const submit = jest.fn<RuntimeApplication['analystRuntime']['submit']>(async () => ({ sessionId: 'analyst:global', toolInvocations: [], restart: null }));
  const acknowledge = jest.fn(async () => undefined);
  let snapshots: ExecutingLlmSnapshot[];
  const authHeaders = { authorization: 'Bearer route-token' };

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-chat-routes-'));
    initProjectTree(projectRoot);
    submit.mockClear();
    acknowledge.mockClear();
    snapshots = [];
    fastify = Fastify({ logger: false });
    const handlers = buildChatOperatorContractHandlers({
      projectRoot,
      runtimeApplication: { analystRuntime: { submit }, captureExecutingLlmSnapshots: () => snapshots } as unknown as RuntimeApplication,
      saivageConfig: TEST_SAIVAGE_CONFIG,
      restartPort: { schedule: jest.fn(), acknowledge },
    });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'route-token' }), eventLogger: createEventLog(projectRoot) }).mount(fastify, chatOperatorApiContracts, handlers);
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('admits canonical GET and returns an empty transcript when no conversation exists', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/chats/analyst%3Aglobal',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ session: null, entries: [], activity_status: { status: 'inactive', pending_calls: [] } });
  });

  it('leaves the removed aggregate chat URL to ordinary Fastify not-found handling', async () => {
    const response = await fastify.inject({ method: 'GET', url: '/api/chats', headers: authHeaders });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: 'Not Found', statusCode: 404 });
  });

  it('admits canonical POST and submits the Analyst turn', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chats/analyst%3Aglobal',
      headers: authHeaders,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: 'analyst:global', toolInvocations: [], restart: null });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({
      userContent: 'hello',
      workspaceContext: undefined,
    });
  });

  it('preserves optional content semantics after request parsing', async () => {
    const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst%3Aglobal', headers: authHeaders, payload: {} });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: 'Message content is required' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('lets an unexpected Analyst submission failure reach the strict contract boundary', async () => {
    const marker = 'hostile-chat-submit-token';
    submit.mockRejectedValueOnce(Object.assign(new Error(`message-${marker}`), {
      token: marker,
      path: `/secret/${marker}`,
      cause: { marker },
    }));

    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chats/analyst%3Aglobal',
      headers: authHeaders,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(response.body).not.toContain(marker);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed workspace context before Analyst submission', async () => {
    const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst%3Aglobal', headers: authHeaders, payload: { content: 'hello', workspaceContext: { view: 1, entityId: null, refinement: null } } });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: 'ValidationError' });
    expect(submit).not.toHaveBeenCalled();
  });

  it('acknowledges a scheduled restart after the reply finishes', async () => {
    submit.mockResolvedValueOnce({ sessionId: 'analyst:global', toolInvocations: [], restart: { status: 'scheduled' } });

    const response = await fastify.inject({ method: 'POST', url: '/api/chats/analyst%3Aglobal', headers: authHeaders, payload: { content: 'restart' } });
    await new Promise((resolve) => setImmediate(resolve));

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ sessionId: 'analyst:global', toolInvocations: [], restart: { status: 'scheduled' } });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });

  it('does not advertise a production-impossible 503 response', () => {
    expect(chatOperatorApiContracts['chats.send'].response).not.toHaveProperty('503');
  });

  it.each(['inactive', 'active', 'waiting'] as const)('returns the present %s Analyst projection unchanged from agents.conversation', async (status) => {
    const inputId = '11111111-1111-4111-8111-111111111111';
    const ingress = buildAnalystIngressRows(inputId, 'workspace', 'question');
    appendConversationBatch({ projectRoot }, ingress);
    appendConversationBatch({ projectRoot }, [{ id: `${inputId}:tool-call:call-1`, session_id: 'analyst:global', role: 'assistant', kind: 'tool_call', tool: 'webfetch', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' } }] }), round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 3, block_index: 0, timestamp: ingress[2].timestamp }]);
    if (status === 'inactive') appendConversationBatch({ projectRoot }, [{ id: `${inputId}:tool-result:call-1`, session_id: 'analyst:global', role: 'tool', kind: 'tool_result', tool: 'webfetch', tool_call_id: 'call-1', content: '{"success":false,"error":"settled"}', round_id: `r-assistant-${inputId.replaceAll('-', '')}`, message_index: 4, block_index: 0, timestamp: ingress[2].timestamp }]);
    if (status !== 'inactive') snapshots = [{ sessionId: 'analyst:global', agentId: 'analyst:global', role: 'analyst', cardId: null, activity: status === 'active' ? { mode: 'active', barrier: null } : { mode: 'waiting', barrier: { kind: 'external', sessionId: 'analyst:global', sourceInputId: inputId, toolCallId: 'call-1', toolName: 'webfetch' } } }];
    const expected = new AgentOperatorReadModelService(projectRoot, () => snapshots).getConversation('analyst:global').body;
    const response = await fastify.inject({ method: 'GET', url: '/api/chats/analyst%3Aglobal', headers: authHeaders });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(expected);
  });

  it('rejects a non-Analyst GET identity before handler dependencies are used', async () => {
    const response = await fastify.inject({
      method: 'GET',
      url: '/api/chats/planner%3Aproject',
      headers: authHeaders,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ValidationError',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'sessionId' })]),
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('rejects a non-Analyst POST identity before Analyst submission', async () => {
    const response = await fastify.inject({
      method: 'POST',
      url: '/api/chats/planner%3Aproject',
      headers: authHeaders,
      payload: { content: 'hello' },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: 'ValidationError',
      issues: expect.arrayContaining([expect.objectContaining({ path: 'sessionId' })]),
    });
    expect(submit).not.toHaveBeenCalled();
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

import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { chatOperatorApiContracts } from '../../src/contracts/operator-api-chats.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildChatOperatorContractHandlers } from '../../src/server/routes/operator-chat-handlers.js';

describe('operator chat route request contracts', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  const cardRead = jest.fn();
  const submit = jest.fn(async () => ({ sessionId: 'analyst:global' as const, toolInvocations: [], restart: null }));
  const authHeaders = { authorization: 'Bearer route-token' };

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-chat-routes-'));
    cardRead.mockClear();
    submit.mockClear();
    fastify = Fastify({ logger: false });
    const handlers = buildChatOperatorContractHandlers({
      projectRoot,
      cardStore: { read: cardRead },
      runtimeApplication: { analystRuntime: { submit } },
      saivageConfig: {},
    } as never);
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'route-token' }) }).mount(fastify, chatOperatorApiContracts, handlers);
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
    expect(response.json()).toEqual({ sessionId: 'analyst:global', entries: [] });
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
      actor: 'analyst',
      surface: 'web-chat',
    });
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
    expect(cardRead).not.toHaveBeenCalled();
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

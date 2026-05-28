import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { resetAuthPolicyForTests, configureAuthPolicy } from '../../src/server/auth-policy.js';
import { writeLatestLlmExchange, exchangePath } from '../../src/agents/llm-exchange-log.js';
import type { LlmExchange } from '../../src/contracts/llm-exchange.js';

const AUTH_TOKEN = 'test-llm-exchange-token';

function makeExchange(sessionId: string): LlmExchange {
  return {
    sessionId,
    capturedAt: '2026-05-23T10:00:00.000Z',
    transport: 'generic',
    candidate: { provider: 'test-provider', model: 'test-model' },
    attempts: [
      {
        attempt: 0,
        startedAt: '2026-05-23T10:00:00.000Z',
        completedAt: '2026-05-23T10:00:01.000Z',
        status: 'ok',
        request: {
          endpoint: 'https://example.test/v1/chat',
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: { messages: [{ role: 'user', content: 'hi' }] },
        },
        response: {
          status: 200,
          headers: { 'content-type': 'application/json' },
          bodyRaw: '{"ok":true}',
          bodyParsed: { ok: true },
        },
      },
    ],
  };
}

describe('GET /api/agents/:id/llm-exchange', () => {
  let projectRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-exch-route-'));
    initProjectTree(projectRoot);
    initRuntimeState(projectRoot);
    mkdirSync(join(projectRoot, '.saivage', 'agents', 'llm-exchanges'), { recursive: true });
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    resetAuthPolicyForTests();
    configureAuthPolicy({ apiToken: AUTH_TOKEN });

    app = Fastify({ logger: false });
    await app.register(cors);
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);
    const { registerOperatorContractRoutes } = await import('../../src/server/routes/operator-contracts.js');
    registerOperatorContractRoutes({ fastify: app, projectRoot });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* noop */ }
    delete process.env['SAIVAGE_API_TOKEN'];
    resetAuthPolicyForTests();
  });

  function authHdr(): Record<string, string> { return { authorization: `Bearer ${AUTH_TOKEN}` }; }

  it('returns 200 with the recorded exchange', async () => {
    const exchange = makeExchange('sess-200');
    await writeLatestLlmExchange(join(projectRoot, '.saivage'), exchange);

    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/sess-200/llm-exchange',
      headers: authHdr(),
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ exchange: LlmExchange }>();
    expect(body.exchange).toEqual(exchange);
  });

  it('returns 404 when no exchange has been recorded yet', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/sess-404/llm-exchange',
      headers: authHdr(),
    });

    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()).toEqual({
      error: 'No LLM exchange recorded for this session yet.',
    });
  });

  it('returns 400 for an agent id violating SAFE_AGENT_ID_RE', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/..%2Fevil/llm-exchange',
      headers: authHdr(),
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>()).toMatchObject({ error: 'Invalid agent session ID' });
  });

  it('returns 401 when no auth token is provided', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/sess-401/llm-exchange',
    });

    expect(res.statusCode).toBe(401);
  });


  it('returns 401 for an invalid auth token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/agents/sess-403/llm-exchange',
      headers: { authorization: 'Bearer wrong-token' },
    });

    expect([401, 403]).toContain(res.statusCode);
  });

  it('returns 500 when the exchange file violates the llm exchange schema', async () => {
    const sessionId = 'sess-malformed';
    const p = exchangePath(join(projectRoot, '.saivage'), sessionId);
    writeFileSync(p, JSON.stringify({ sessionId, capturedAt: '2026-05-23T10:00:00.000Z', attempts: [] }));

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${sessionId}/llm-exchange`,
      headers: authHdr(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Corrupted LLM exchange record.' });
  });

  it('returns 500 when the exchange file is corrupted JSON', async () => {
    const sessionId = 'sess-corrupt';
    const p = exchangePath(join(projectRoot, '.saivage'), sessionId);
    writeFileSync(p, '{not valid json');

    const res = await app.inject({
      method: 'GET',
      url: `/api/agents/${sessionId}/llm-exchange`,
      headers: authHdr(),
    });

    expect(res.statusCode).toBe(500);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Corrupted LLM exchange record.' });
  });
});

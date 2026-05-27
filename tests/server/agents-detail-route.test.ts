import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState } from '../../src/runtime/state.js';
import { resetAuthPolicyForTests, configureAuthPolicy } from '../../src/server/auth-policy.js';

const AUTH_TOKEN = 'test-agent-detail-token';

function writeMessages(projectRoot: string, sessionId: string, messages: Array<Record<string, unknown>>): void {
  mkdirSync(join(projectRoot, '.saivage', 'agents', 'messages'), { recursive: true });
  const filePath = join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`);
  const stamped = messages.map((message, index) => ({
    id: `msg-${sessionId}-${index + 1}`,
    session_id: sessionId,
    kind: 'text',
    round_id: `r-${message['role'] === 'user' ? 'user' : 'assistant'}-${index + 1}`,
    message_index: 0,
    block_index: 0,
    ...message,
  }));
  writeFileSync(filePath, stamped.map((m) => JSON.stringify(m)).join('\n') + '\n');
}

function writeManifest(projectRoot: string, sessionId: string, manifest: Record<string, unknown>): void {
  mkdirSync(join(projectRoot, '.saivage', 'agents', 'sessions'), { recursive: true });
  writeFileSync(join(projectRoot, '.saivage', 'agents', 'sessions', `${sessionId}.json`), JSON.stringify(manifest, null, 2));
}

describe('GET /api/agents/:id', () => {
  let projectRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-detail-'));
    initProjectTree(projectRoot);
    initRuntimeState(projectRoot);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    resetAuthPolicyForTests();
    configureAuthPolicy({ apiToken: AUTH_TOKEN });

    app = Fastify({ logger: false });
    await app.register(cors);
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* noop */ }
    delete process.env['SAIVAGE_API_TOKEN'];
    resetAuthPolicyForTests();
  });

  const authHdr = (): Record<string, string> => ({ authorization: `Bearer ${AUTH_TOKEN}` });

  it('returns 200 with manifest, message counts, and last_activity_at from the latest message', async () => {
    const sessionId = 'analyst';
    writeManifest(projectRoot, sessionId, { role: 'analyst', started_at: '2026-01-01T00:00:00.000Z', completed_at: null });
    writeMessages(projectRoot, sessionId, [
      { timestamp: '2026-01-01T00:00:01.000Z', role: 'user', content: 'hi' },
      { timestamp: '2026-01-01T00:00:02.000Z', role: 'assistant', content: 'hello' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/agents/${sessionId}`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: Record<string, unknown> }>();
    expect(body.session['id']).toBe(sessionId);
    expect(body.session['role']).toBe('analyst');
    expect(body.session['message_count']).toBe(2);
    expect(body.session['last_activity_at']).toBe('2026-01-01T00:00:02.000Z');
  });

  it('returns 200 with messages-only when manifest is missing and infers role from id prefix', async () => {
    const sessionId = 'planner-detail-2';
    writeMessages(projectRoot, sessionId, [
      { timestamp: '2026-02-01T10:00:00.000Z', role: 'user', content: 'plan it' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/agents/${sessionId}`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: Record<string, unknown> }>();
    expect(body.session['role']).toBe('planner');
    expect(body.session['message_count']).toBe(1);
    expect(body.session['last_activity_at']).toBe('2026-02-01T10:00:00.000Z');
  });

  it('returns 200 with manifest-only summary and falls back to completed_at when no messages exist', async () => {
    const sessionId = 'reviewer-detail-3';
    writeManifest(projectRoot, sessionId, {
      role: 'reviewer',
      started_at: '2026-03-01T00:00:00.000Z',
      completed_at: '2026-03-01T00:01:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: `/api/agents/${sessionId}`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: Record<string, unknown> }>();
    expect(body.session['role']).toBe('reviewer');
    expect(body.session['message_count']).toBe(0);
    expect(body.session['last_activity_at']).toBe('2026-03-01T00:01:00.000Z');
    expect(body.session['started_at']).toBe('2026-03-01T00:00:00.000Z');
  });

  it('falls back to started_at when neither messages nor completed_at are present', async () => {
    const sessionId = 'analyst';
    writeManifest(projectRoot, sessionId, {
      role: 'analyst',
      started_at: '2026-04-01T00:00:00.000Z',
    });

    const res = await app.inject({ method: 'GET', url: `/api/agents/${sessionId}`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: Record<string, unknown> }>();
    expect(body.session['message_count']).toBe(0);
    expect(body.session['last_activity_at']).toBe('2026-04-01T00:00:00.000Z');
  });

  it('returns 400 for an invalid agent session id', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/..%2Fevil/', headers: authHdr() });
    expect([400, 404]).toContain(res.statusCode);
    const res2 = await app.inject({ method: 'GET', url: '/api/agents/has spaces', headers: authHdr() });
    expect([400, 404]).toContain(res2.statusCode);
  });

  it('returns 404 when neither manifest nor messages exist', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/missing-session', headers: authHdr() });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'missing-session' });
  });

  it('does not expose historical non-canonical analyst sessions through the web API', async () => {
    writeManifest(projectRoot, 'analyst', { role: 'analyst', started_at: '2026-01-01T00:00:00.000Z' });
    writeManifest(projectRoot, 'chat-old', { role: 'analyst', started_at: '2026-01-02T00:00:00.000Z' });
    writeManifest(projectRoot, 'planner-detail-5', { role: 'planner', started_at: '2026-01-03T00:00:00.000Z' });

    const listRes = await app.inject({ method: 'GET', url: '/api/agents', headers: authHdr() });
    expect(listRes.statusCode).toBe(200);
    const ids = listRes.json<{ sessions: Array<{ id: string }> }>().sessions.map((session) => session.id);
    expect(ids).toContain('analyst');
    expect(ids).toContain('planner-detail-5');
    expect(ids).not.toContain('chat-old');

    const detailRes = await app.inject({ method: 'GET', url: '/api/agents/chat-old', headers: authHdr() });
    expect(detailRes.statusCode).toBe(404);
    expect(detailRes.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'chat-old' });
  });


  it('returns canonical conversation entries with required activity status and no messages field', async () => {
    const sessionId = 'planner-conversation-1';
    writeManifest(projectRoot, sessionId, { role: 'planner', started_at: '2026-05-01T00:00:00.000Z' });
    writeMessages(projectRoot, sessionId, [
      { timestamp: '2026-05-01T00:00:01.000Z', role: 'assistant', content: 'contract-backed entry' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/agents/${sessionId}/conversation`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toHaveProperty('session');
    expect(body).toHaveProperty('entries');
    expect(body).toHaveProperty('activity_status');
    expect(body).not.toHaveProperty('messages');
    expect((body['entries'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      session_id: sessionId,
      role: 'assistant',
      kind: 'text',
      content: 'contract-backed entry',
    });
    expect(body['activity_status']).toEqual({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() });
  });

  it('returns 404 for missing canonical conversation sessions', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/missing-conversation/conversation', headers: authHdr() });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'missing-conversation' });
  });

  it('returns 401 for conversation requests without auth', async () => {
    writeManifest(projectRoot, 'planner-conversation-auth', { role: 'planner', started_at: '2026-05-01T00:00:00.000Z' });
    const res = await app.inject({ method: 'GET', url: '/api/agents/planner-conversation-auth/conversation' });
    expect(res.statusCode).toBe(401);
  });

  it('does not expose non-canonical analyst conversations', async () => {
    writeManifest(projectRoot, 'chat-old', { role: 'analyst', started_at: '2026-01-02T00:00:00.000Z' });
    writeMessages(projectRoot, 'chat-old', [
      { timestamp: '2026-01-02T00:00:01.000Z', role: 'assistant', content: 'historical analyst transcript' },
    ]);
    const res = await app.inject({ method: 'GET', url: '/api/agents/chat-old/conversation', headers: authHdr() });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'chat-old' });
  });

  it('returns 401 when no auth token is provided', async () => {
    writeManifest(projectRoot, 'analyst-auth', { role: 'analyst', started_at: '2026-01-01T00:00:00.000Z' });
    const res = await app.inject({ method: 'GET', url: '/api/agents/analyst-auth' });
    expect(res.statusCode).toBe(401);
  });
});

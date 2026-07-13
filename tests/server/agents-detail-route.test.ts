import { CardStore, initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { testActorSnapshots } from '../helpers/actor-snapshots.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';


import { readRuntimeState } from '../../src/runtime/state.js';
import { initRuntimeState, saveRuntimeState } from '../helpers/runtime-state.js';
import { appendTestConversationMessage as appendConversationMessage } from '../helpers/conversation-mutations.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import type { AgentMessage } from '../../src/schemas/index.js';

const AUTH_TOKEN = 'test-agent-detail-token';

function message(sessionId: string, index: number, overrides: Partial<AgentMessage>): AgentMessage {
  const role = overrides.role ?? 'assistant';
  const timestamp = overrides.timestamp ?? `2026-01-01T00:00:0${index}.000Z`;
  const roundKind = role === 'system' ? 'pre' : role === 'user' ? 'user' : 'assistant';
  return {
    id: `${sessionId}:msg-${index}`,
    session_id: sessionId,
    kind: overrides.kind ?? 'text',
    role,
    content: overrides.content ?? `message ${index}`,
    round_id: `r-${roundKind}-${index.toString(16).padStart(32, '0')}`,
    message_index: index,
    block_index: 0,
    timestamp,
    ...overrides,
  } as AgentMessage;
}

function writeConversation(projectRoot: string, sessionId: string, messages: Array<Partial<AgentMessage>>): void {
  messages.forEach((entry, index) => appendConversationMessage(projectRoot, message(sessionId, index + 1, entry)));
}

describe('GET /api/agents/:id', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let cardStore: CardStore;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-agent-detail-'));
    initProjectTree(projectRoot);
    cardStore = new CardStore(projectRoot);
    initRuntimeState(projectRoot);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;

    app = Fastify({ logger: false });
    await app.register(cors);
    const { registerOperatorContractRoutes } = await import('../../src/server/routes/operator-contracts.js');
    registerOperatorContractRoutes({ fastify: app, projectRoot, configAuthority: testConfigAuthority(projectRoot), authPolicy: new AuthPolicy({ apiToken: AUTH_TOKEN }), cardStore: cardStore.repository });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
    delete process.env['SAIVAGE_API_TOKEN'];
  });

  const authHdr = (): Record<string, string> => ({ authorization: `Bearer ${AUTH_TOKEN}` });

  it('lists segment-backed sessions in descending started_at order', async () => {
    writeConversation(projectRoot, 'planner:old-goal', [{ role: 'system', content: 'old', timestamp: '2026-01-01T00:00:00.000Z' }]);
    writeConversation(projectRoot, 'reviewer:new-goal:assessment-1', [{ role: 'assistant', content: 'new', timestamp: '2026-01-02T00:00:00.000Z' }]);

    const res = await app.inject({ method: 'GET', url: '/api/agents', headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const sessions = res.json<{ sessions: Array<Record<string, unknown>> }>().sessions;
    expect(sessions.map((session) => session['id'])).toEqual(['reviewer:new-goal:assessment-1', 'planner:old-goal']);
    expect(sessions[0]).toMatchObject({ role: 'reviewer', card_id: 'new-goal', assessment_id: 'assessment-1', status: 'inactive' });
    expect(sessions[1]).toMatchObject({ role: 'planner', card_id: 'old-goal', status: 'inactive' });
  });

  it('does not synthesize the analyst session before conversation messages exist', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/agents', headers: authHdr() });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json<{ sessions: Array<{ id: string }> }>().sessions).toEqual([]);

    const detailRes = await app.inject({ method: 'GET', url: '/api/agents/analyst%3Aglobal', headers: authHdr() });
    expect(detailRes.statusCode).toBe(404);
    expect(detailRes.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'analyst:global' });
  });

  it('returns detail with message counts and last activity from segment entries', async () => {
    writeConversation(projectRoot, 'analyst:global', [
      { role: 'user', content: 'hi', timestamp: '2026-01-01T00:00:01.000Z' },
      { role: 'assistant', content: 'hello', timestamp: '2026-01-01T00:00:02.000Z' },
    ]);

    const res = await app.inject({ method: 'GET', url: '/api/agents/analyst%3Aglobal', headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ session: Record<string, unknown> }>();
    expect(body.session).toMatchObject({ id: 'analyst:global', role: 'analyst', message_count: 2, last_activity_at: '2026-01-01T00:00:02.000Z' });
    expect(body).not.toHaveProperty('messages');
    expect(body.session).not.toHaveProperty('messages');
  });

  it('derives active, waiting, and inactive statuses from actor snapshots and card state', async () => {
    writeConversation(projectRoot, 'planner:project', [{ role: 'system', content: 'active', timestamp: '2026-02-03T00:00:00.000Z' }]);
    writeConversation(projectRoot, 'executor:project', [{ role: 'system', content: 'waiting', timestamp: '2026-02-02T00:00:00.000Z' }]);
    writeConversation(projectRoot, 'reviewer:project:assessment-1', [{ role: 'system', content: 'inactive', timestamp: '2026-02-01T00:00:00.000Z' }]);
    testActorSnapshots(projectRoot).save({ actor_id: 'planner:project', actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-02-03T00:00:01.000Z' });
    testActorSnapshots(projectRoot).save({ actor_id: 'executor:project', actor_kind: 'llm', state_value: 'waiting_tool', context: {}, updated_at: '2026-02-03T00:00:02.000Z' });

    const res = await app.inject({ method: 'GET', url: '/api/agents', headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const byId = new Map(res.json<{ sessions: Array<Record<string, unknown>> }>().sessions.map((session) => [session['id'], session]));
    expect(byId.get('planner:project')?.['status']).toBe('active');
    expect(byId.get('executor:project')?.['status']).toBe('waiting');
    expect(byId.get('reviewer:project:assessment-1')?.['status']).toBe('inactive');
  });

  it('returns canonical conversation entries with activity status and no messages field', async () => {
    const sessionId = 'planner:conversation-1';
    writeConversation(projectRoot, sessionId, [
      { role: 'system', kind: 'system_prompt', content: 'Plan and coordinate card conversation-1', timestamp: '2026-05-01T00:00:00.000Z' },
      { role: 'assistant', content: 'contract-backed entry', timestamp: '2026-05-01T00:00:01.000Z' },
    ]);

    const res = await app.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(sessionId)}/conversation`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body).toHaveProperty('session');
    expect(body).toHaveProperty('entries');
    expect(body).toHaveProperty('activity_status');
    expect(body).not.toHaveProperty('messages');
    expect((body['entries'] as Array<Record<string, unknown>>)[0]).toMatchObject({ session_id: sessionId, role: 'system', kind: 'system_prompt', content: 'Plan and coordinate card conversation-1' });
    expect((body['entries'] as Array<Record<string, unknown>>)[1]).toMatchObject({ session_id: sessionId, role: 'assistant', kind: 'text', content: 'contract-backed entry' });
    expect(body['activity_status']).toEqual({ status: 'idle', pending_calls: [], updated_at: new Date(0).toISOString() });
  });

  it('returns thinking activity status from actor snapshots', async () => {
    const sessionId = 'planner:thinking';
    writeConversation(projectRoot, sessionId, [{ role: 'system', content: 'thinking' }]);
    testActorSnapshots(projectRoot).save({ actor_id: sessionId, actor_kind: 'llm', state_value: 'calling_provider', context: {}, updated_at: '2026-06-01T00:00:00.000Z' });

    const res = await app.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(sessionId)}/conversation`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()['activity_status']).toEqual({ status: 'thinking', pending_calls: [], updated_at: '2026-06-01T00:00:00.000Z' });
  });

  it('returns terminal card status for inactive card-bound sessions', async () => {
    const state = readRuntimeState(projectRoot);
    if (!state) throw new Error('expected initialized runtime state');
    saveRuntimeState(projectRoot, { ...state, status: 'stopped' });
    const sessionId = 'planner:project';
    writeConversation(projectRoot, sessionId, [{ role: 'system', content: 'done planner' }]);
    cardStore.setStatus('project', 'running');
    cardStore.setStatus('project', 'blocked');

    const res = await app.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(sessionId)}`, headers: authHdr() });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ session: Record<string, unknown> }>().session['status']).toBe('blocked');
  });

  it('returns 400 or 404 for invalid agent session ids', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/..%2Fevil/', headers: authHdr() });
    expect([400, 404]).toContain(res.statusCode);
    const res2 = await app.inject({ method: 'GET', url: '/api/agents/has spaces', headers: authHdr() });
    expect([400, 404]).toContain(res2.statusCode);
  });

  it('returns 404 when no segment conversation exists', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/agents/missing-session', headers: authHdr() });
    expect(res.statusCode).toBe(404);
    expect(res.json<Record<string, unknown>>()).toEqual({ error: 'Agent session not found', sessionId: 'missing-session' });
  });

  it('returns 401 for detail and conversation requests without auth', async () => {
    writeConversation(projectRoot, 'analyst:global', [{ role: 'user', content: 'hi' }]);
    const detailRes = await app.inject({ method: 'GET', url: '/api/agents/analyst%3Aglobal' });
    expect(detailRes.statusCode).toBe(401);
    const conversationRes = await app.inject({ method: 'GET', url: '/api/agents/analyst%3Aglobal/conversation' });
    expect(conversationRes.statusCode).toBe(401);
  });
});

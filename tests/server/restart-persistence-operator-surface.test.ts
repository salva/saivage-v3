import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { runtimeStateSchema } from '../../src/schemas/validators.js';
import { readRuntimeState } from '../../src/utils/runtime-state.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import type { RuntimeState } from '../../src/schemas/types.js';

const AUTH_HEADER = { authorization: 'Bearer restart-surface-test-token' };
const NOW = '2026-05-19T12:00:00.000Z';
const SECRET_TOKEN = 'tok_restart_surface_secret_123';
const SECRET_API_KEY = 'sk-restart-surface-secret-456';
const SECRET_AUTHORIZATION = 'Bearer restart-surface-secret-789';

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeJsonl(path: string, entries: unknown[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

function writeMessage(projectRoot: string, sessionId: string, timestamp: string): void {
  writeJsonl(join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`), [
    {
      id: `msg-${sessionId.replace(/[^a-zA-Z0-9_-]/g, '-')}-1`,
      session_id: sessionId,
      role: 'assistant',
      kind: 'text',
      content: `synthetic persisted message for ${sessionId}`,
      timestamp,
    },
  ]);
}

async function restartServer(server: ServerInstance, projectRoot: string): Promise<ServerInstance> {
  await server.stop();
  return createServer(projectRoot, false);
}

function expectRuntimeStateCoherent(runtime: unknown): RuntimeState {
  const parsed = runtimeStateSchema.safeParse(runtime);
  expect(parsed.success).toBe(true);
  if (!parsed.success) throw new Error(parsed.error.message);

  const state = parsed.data;
  expect(state.current_agent_session_id).toBe('executor:C9');
  expect(state.status).toBe('running');
  expect(state.current_card_id).toBe('C9');
  expect(state.active_card_run).toMatchObject({
    card_id: 'C9',
    phase: 'executor',
    runtime_status: 'running',
    executor_session_id: 'executor:C9',
  });
  expect(state.running_processes).toEqual([]);
  expect(state.queue).toEqual(['C9']);
  return state;
}

function stringify(value: unknown): string {
  return JSON.stringify(value);
}

describe('restart/reload operator-visible persistence surfaces', () => {
  let projectRoot: string;
  let server: ServerInstance;
  const originalToken = process.env['SAIVAGE_API_TOKEN'];
  const originalNodeEnv = process.env['NODE_ENV'];

  beforeEach(async () => {
    process.env['SAIVAGE_API_TOKEN'] = 'restart-surface-test-token';
    process.env['NODE_ENV'] = 'test';
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-restart-surface-'));
    initProjectTree(projectRoot);
    for (const dir of ['agents/messages', 'agents/sessions', 'runtime']) {
      mkdirSync(join(projectRoot, '.saivage', dir), { recursive: true });
    }

    writeMessage(projectRoot, 'analyst', '2026-05-19T12:00:01.000Z');
    writeMessage(projectRoot, 'planner:G3', '2026-05-19T12:00:02.000Z');
    writeMessage(projectRoot, 'reviewer:G3', '2026-05-19T12:00:03.000Z');
    writeMessage(projectRoot, 'executor:C9', '2026-05-19T12:00:04.000Z');
    writeMessage(projectRoot, 'card-C9', '2026-05-19T12:00:05.000Z');

    writeJson(join(projectRoot, '.saivage', 'agents', 'sessions', 'executor:C9.json'), {
      id: 'executor:C9',
      role: 'executor',
      goal_card_id: 'G3',
      card_id: 'C9',
      status: 'active',
      started_at: '2026-05-19T12:00:04.000Z',
      model: 'synthetic-model',
    });

    writeJson(join(projectRoot, '.saivage', 'runtime', 'state.json'), {
      status: 'running',
      project_id: 'project',
      pid: process.pid,
      started_at: NOW,
      current_card_id: 'C9',
      current_agent_session_id: 'executor:C9',
      active_card_run: {
        card_id: 'C9',
        card_type: 'code',
        runtime_status: 'running',
        phase: 'executor',
        caller_session_id: 'planner:G3',
        caller_tool_call_id: 'call-synthetic-activate',
        planner_session_id: 'planner:G3',
        executor_session_id: 'executor:C9',
        reviewer_session_id: null,
        correction_attempts: 0,
        started_at: NOW,
        last_turn_at: '2026-05-19T12:00:04.000Z',
      },
      paused: false,
      paused_at: null,
      queue: ['C9'],
      running_processes: [],
      updated_at: '2026-05-19T12:00:06.000Z',
      frozen_reason: null,
    });

    writeJsonl(join(projectRoot, '.saivage', 'runtime', 'events.jsonl'), [
      {
        id: 'evt-secret-1',
        kind: 'invocation_failed',
        timestamp: '2026-05-19T12:00:07.000Z',
        session_id: 'executor:C9',
        error_message: `provider body {"token":"${SECRET_TOKEN}","api_key":"${SECRET_API_KEY}","authorization":"${SECRET_AUTHORIZATION}"}`,
        provider_body: {
          token: SECRET_TOKEN,
          api_key: SECRET_API_KEY,
          authorization: SECRET_AUTHORIZATION,
          nested: { token: SECRET_TOKEN },
        },
      },
    ]);

    writeJsonl(join(projectRoot, '.saivage', 'runtime', 'errors.jsonl'), [
      {
        id: 'err-secret-1',
        timestamp: '2026-05-19T12:00:08.000Z',
        session_id: 'executor:C9',
        error: {
          message: `request failed token=${SECRET_TOKEN} api_key=${SECRET_API_KEY}`,
          authorization: SECRET_AUTHORIZATION,
        },
      },
    ]);

    server = await createServer(projectRoot, false);
    server = await restartServer(server, projectRoot);
  });

  afterEach(async () => {
    await server.stop();
    rmSync(projectRoot, { recursive: true, force: true });
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    if (originalNodeEnv === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = originalNodeEnv;
  });

  it('enumerates persisted agent message sessions after reload and marks exactly current_agent_session_id active', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/api/agents', headers: AUTH_HEADER });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ sessions: Array<{ id: string; role: string; status: string; card_id?: string; goal_card_id?: string; model?: string }> }>();
    const byId = new Map(body.sessions.map((session) => [session.id, session]));

    expect([...byId.keys()].sort()).toEqual(['analyst', 'card-C9', 'executor:C9', 'planner:G3', 'reviewer:G3']);
    expect(byId.get('analyst')).toMatchObject({ role: 'analyst', status: 'inactive' });
    expect(byId.get('planner:G3')).toMatchObject({ role: 'planner', status: 'inactive' });
    expect(byId.get('reviewer:G3')).toMatchObject({ role: 'reviewer', status: 'inactive' });
    expect(byId.get('executor:C9')).toMatchObject({ role: 'executor', status: 'active', goal_card_id: 'G3', card_id: 'C9', model: 'synthetic-model' });
    expect(byId.get('card-C9')).toMatchObject({ role: 'analyst', status: 'inactive' });
    expect(body.sessions.filter((session) => session.status === 'active').map((session) => session.id)).toEqual(['executor:C9']);
  });

  it('redacts synthetic token/api_key/authorization values from debug timeline and errors after reload', async () => {
    const timelineResponse = await server.fastify.inject({ method: 'GET', url: '/api/debug/timeline', headers: AUTH_HEADER });
    const errorsResponse = await server.fastify.inject({ method: 'GET', url: '/api/debug/errors', headers: AUTH_HEADER });
    expect(timelineResponse.statusCode).toBe(200);
    expect(errorsResponse.statusCode).toBe(200);

    const timelineBody = timelineResponse.json<{ events: unknown[]; total: number }>();
    const errorsBody = errorsResponse.json<{ errors: unknown[]; total: number }>();
    expect(timelineBody.total).toBe(1);
    expect(errorsBody.total).toBe(1);

    const exposed = `${stringify(timelineBody)}\n${stringify(errorsBody)}`;
    expect(exposed).not.toContain(SECRET_TOKEN);
    expect(exposed).not.toContain(SECRET_API_KEY);
    expect(exposed).not.toContain(SECRET_AUTHORIZATION);
    expect(exposed).toContain('[REDACTED]');
    expect(timelineBody.events[0]).toMatchObject({
      provider_body: {
        token: '[REDACTED]',
        api_key: '[REDACTED]',
        authorization: '[REDACTED]',
        nested: { token: '[REDACTED]' },
      },
    });
  });

  it('returns schema-valid coherent RuntimeState after reload and keeps /api/agents active status in sync', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: AUTH_HEADER });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ runtime: unknown; cardIndex: unknown }>();
    const state = expectRuntimeStateCoherent(body.runtime);
    expect(readRuntimeState(projectRoot)).toMatchObject({ current_agent_session_id: state.current_agent_session_id });

    const agentsResponse = await server.fastify.inject({ method: 'GET', url: '/api/agents', headers: AUTH_HEADER });
    expect(agentsResponse.statusCode).toBe(200);
    const activeSessions = agentsResponse.json<{ sessions: Array<{ id: string; status: string }> }>().sessions.filter((session) => session.status === 'active');
    expect(activeSessions.map((session) => ({ id: session.id, status: session.status }))).toEqual([{ id: state.current_agent_session_id, status: 'active' }]);
  });
});

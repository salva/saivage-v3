import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function uniqueDir(): string {
  return join(tmpdir(), `saivage-agents-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function writeJsonl(projectRoot: string, sessionId: string, timestamp: string): void {
  const message = {
    id: `msg-${sessionId}-1`,
    session_id: sessionId,
    role: 'assistant',
    kind: 'text',
    content: `hello from ${sessionId}`,
    timestamp,
  };
  writeFileSync(join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`), `${JSON.stringify(message)}\n`);
}

async function makeApp(projectRoot: string): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  process.env['SAIVAGE_API_TOKEN'] = 'test-token';
  const { default: authPlugin } = await import('../../src/server/auth.js');
  const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
  await app.register(authPlugin);
  registerRuntimeConfigNotesRoutes(app, projectRoot);
  return app;
}

describe('GET /api/agents persisted JSONL enumeration', () => {
  let projectRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    projectRoot = uniqueDir();
    for (const dir of ['agents/messages', 'agents/sessions', 'runtime', 'cards/by-id', 'cards/tree', 'cards/dependencies']) {
      mkdirSync(join(projectRoot, '.saivage', dir), { recursive: true });
    }
    writeJsonl(projectRoot, 'analyst', '2025-01-01T00:00:00.000Z');
    writeJsonl(projectRoot, 'planner:G3', '2025-01-01T00:01:00.000Z');
    writeJsonl(projectRoot, 'reviewer:G3', '2025-01-01T00:02:00.000Z');
    writeJsonl(projectRoot, 'executor:C9', '2025-01-01T00:03:00.000Z');
    writeJsonl(projectRoot, 'card-C9', '2025-01-01T00:04:00.000Z');
    writeFileSync(join(projectRoot, '.saivage', 'agents', 'sessions', 'planner:G3.json'), JSON.stringify({
      id: 'planner:G3',
      role: 'planner',
      goal_card_id: 'G3',
      card_id: 'G3',
      status: 'active',
      started_at: '2025-01-01T00:01:00.000Z',
      model: 'test-model',
    }, null, 2));
    writeFileSync(join(projectRoot, '.saivage', 'runtime', 'state.json'), JSON.stringify({
      status: 'running',
      project_id: 'project',
      pid: process.pid,
      started_at: '2025-01-01T00:00:00.000Z',
      current_agent_session_id: 'planner:G3',
      paused: false,
      queue: [],
      running_processes: [],
      updated_at: '2025-01-01T00:05:00.000Z',
    }, null, 2));
    app = await makeApp(projectRoot);
  });

  afterEach(async () => {
    await app.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('lists every persisted JSONL session with parsed roles and active/inactive status', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer test-token' } });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: Array<{ id: string; role: string; status: string; goal_card_id?: string; model?: string }> };
    const byId = new Map(body.sessions.map((session) => [session.id, session]));

    expect([...byId.keys()].sort()).toEqual(['analyst', 'card-C9', 'executor:C9', 'planner:G3', 'reviewer:G3']);
    expect(byId.get('analyst')).toMatchObject({ role: 'analyst', status: 'inactive' });
    expect(byId.get('planner:G3')).toMatchObject({ role: 'planner', status: 'active', goal_card_id: 'G3', model: 'test-model' });
    expect(byId.get('reviewer:G3')).toMatchObject({ role: 'reviewer', status: 'inactive' });
    expect(byId.get('executor:C9')).toMatchObject({ role: 'executor', status: 'inactive' });
    expect(byId.get('card-C9')).toMatchObject({ role: 'analyst', status: 'inactive' });
  });

  it('marks a planner session waiting when its runtime planner run remains open', async () => {
    const now = '2025-01-01T00:06:00.000Z';
    rmSync(join(projectRoot, '.saivage', 'runtime', 'state.json'), { force: true });
    mkdirSync(join(projectRoot, '.saivage', 'tmp', 'state'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'tmp', 'state', 'runtime.json'), JSON.stringify({
      status: 'running',
      project_id: 'project',
      pid: process.pid,
      started_at: '2025-01-01T00:00:00.000Z',
      current_card_id: 'C9',
      current_agent_session_id: 'executor:C9',
      active_card_run: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
      frozen_reason: null,
      runtime_intent: { status: 'running', updated_at: now, source_command_id: 'cmd-start', reason: 'test' },
      runtime_commands: [],
      runtime_runs: [{
        run_id: 'run-planner-g3',
        kind: 'child',
        card_id: 'G3',
        parent_run_id: 'run-project',
        command_id: null,
        activation_id: 'act-g3',
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:G3',
        started_at: '2025-01-01T00:01:00.000Z',
        updated_at: now,
        finished_at: null,
        result: null,
      }],
      runtime_activations: [],
    }, null, 2));

    const response = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer test-token' } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: Array<{ id: string; status: string }> };
    const byId = new Map(body.sessions.map((session) => [session.id, session]));
    expect(byId.get('planner:G3')).toMatchObject({ status: 'waiting' });
    expect(byId.get('executor:C9')).toMatchObject({ status: 'active' });
  });

  it('keeps an active executor live while its parent planner is waiting', async () => {
    const now = '2025-01-01T00:07:00.000Z';
    rmSync(join(projectRoot, '.saivage', 'runtime', 'state.json'), { force: true });
    mkdirSync(join(projectRoot, '.saivage', 'tmp', 'state'), { recursive: true });
    writeFileSync(join(projectRoot, '.saivage', 'agents', 'sessions', 'executor:C9.json'), JSON.stringify({
      id: 'executor:C9',
      role: 'executor',
      goal_card_id: 'G3',
      card_id: 'C9',
      status: 'active',
      started_at: '2025-01-01T00:03:00.000Z',
      completed_at: null,
      model: 'test-model',
    }, null, 2));
    writeFileSync(join(projectRoot, '.saivage', 'tmp', 'state', 'runtime.json'), JSON.stringify({
      status: 'running',
      project_id: 'project',
      pid: process.pid,
      started_at: '2025-01-01T00:00:00.000Z',
      current_card_id: 'C9',
      current_agent_session_id: 'planner:G3',
      active_card_run: {
        card_id: 'C9',
        card_type: 'code',
        runtime_status: 'running',
        phase: 'executor',
        caller_session_id: 'planner:G3',
        caller_tool_call_id: 'call-activate-c9',
        planner_session_id: null,
        correction_attempts: 0,
        started_at: '2025-01-01T00:06:00.000Z',
        last_turn_at: now,
      },
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
      frozen_reason: null,
      runtime_intent: { status: 'running', updated_at: now, source_command_id: 'cmd-start', reason: 'test' },
      runtime_commands: [],
      runtime_runs: [{
        run_id: 'run-planner-g3',
        kind: 'child',
        card_id: 'G3',
        parent_run_id: 'run-project',
        command_id: null,
        activation_id: 'act-g3',
        phase: 'planner',
        runtime_status: 'running',
        session_id: 'planner:G3',
        started_at: '2025-01-01T00:01:00.000Z',
        updated_at: now,
        finished_at: null,
        result: null,
      }],
      runtime_activations: [],
    }, null, 2));

    const response = await app.inject({ method: 'GET', url: '/api/agents', headers: { authorization: 'Bearer test-token' } });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { sessions: Array<{ id: string; status: string }> };
    const byId = new Map(body.sessions.map((session) => [session.id, session]));
    expect(byId.get('planner:G3')).toMatchObject({ status: 'waiting' });
    expect(byId.get('executor:C9')).toMatchObject({ status: 'active' });
  });
});

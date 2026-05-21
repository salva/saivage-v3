import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { initRuntimeState, updateRuntimeState, readRuntimeState } from '../../src/utils/runtime-state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { createSession } from '../../src/agents/session-persistence.js';
import { getNotes } from '../../src/utils/notes.js';

let root: string;
let server: ServerInstance;

function saivageDir(): string { return join(root, '.saivage'); }

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saivage-stage6-api-'));
  initProjectTree(root);
  initRuntimeState(root);
  const store = new CardStore(root);
  store.create({ id: 'goal-a', type: 'goal', parent: 'project', depth: 0, title: 'Goal A', description: '', status: 'done', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, latest_self_report: { summary: 'done' } });
  createSession(saivageDir(), 'planner', 'goal-a', 'goal-a');
  server = await createServer(root, false);
});

afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('stage-6 runtime API', () => {
  it('returns idempotent lets_dance and project correction directive shapes without double-triggering notes', async () => {
    const one = await server.fastify.inject({ method: 'POST', url: '/api/runtime/lets_dance' });
    const two = await server.fastify.inject({ method: 'POST', url: '/api/runtime/lets_dance' });
    expect(one.json()).toEqual(expect.objectContaining({ directive_recorded: true, runtime_status: 'idle', outcome: 'blocked_project_status', directive_state: 'recorded', project_status: 'backlog' }));
    expect(two.json()).toEqual(expect.objectContaining({ directive_recorded: true, runtime_status: 'idle', outcome: 'blocked_project_status', directive_state: 'already_pending', project_status: 'backlog' }));
    expect(getNotes(saivageDir(), 'project').filter((note) => note.content.includes('lets_dance')).length).toBe(1);

    const body = { issues: [{ summary: 'project issue', severity: 'blocker', evidence_path: '.saivage/auth-profiles.json' }], note: 'password=hunter2' };
    const p1 = await server.fastify.inject({ method: 'POST', url: '/api/runtime/project/needs_corrections', payload: body });
    const p2 = await server.fastify.inject({ method: 'POST', url: '/api/runtime/project/needs_corrections', payload: body });
    expect(p1.json()).toEqual({ directive_recorded: true, runtime_status: 'idle' });
    expect(p2.json()).toEqual({ directive_recorded: true, runtime_status: 'idle' });
    const notes = getNotes(saivageDir(), 'project').filter((note) => note.content.includes('project_needs_corrections'));
    expect(notes).toHaveLength(1);
    expect(JSON.stringify(notes)).not.toContain('hunter2');
  });

  it('records goal needs_corrections with the canonical AnalystIssue shape and no resumed planner session id', async () => {
    const response = await server.fastify.inject({ method: 'POST', url: '/api/runtime/goals/goal-a/needs_corrections', payload: { issues: [{ summary: 'missing proof', severity: 'warning' }], note: 'review evidence' } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.origin_goal_id).toBe('goal-a');
    expect(body.notes_recorded_on_goal_ids).toContain('goal-a');
    expect(body.status_transition).toEqual({ from: 'done', to: 'changed' });
    expect(body.resumed_planner_session_id).toBeUndefined();
  });



  it('pause and resume accept an empty JSON body and return the updated persisted RuntimeState shape', async () => {
    const pause = await server.fastify.inject({ method: 'POST', url: '/api/runtime/pause', headers: { 'content-type': 'application/json' } });
    expect(pause.statusCode).toBe(200);
    const paused = pause.json();
    expect(paused).toMatchObject({
      status: 'paused',
      project_id: 'project',
      pid: expect.any(Number),
      paused: true,
      queue: expect.any(Array),
      running_processes: expect.any(Array),
      active_card_run: null,
    });
    expect(typeof paused.started_at).toBe('string');
    expect(typeof paused.updated_at).toBe('string');
    expect(readRuntimeState(root)).toMatchObject({ status: 'paused', paused: true, paused_at: expect.any(String) });

    const resume = await server.fastify.inject({ method: 'POST', url: '/api/runtime/resume', headers: { 'content-type': 'application/json' } });
    expect(resume.statusCode).toBe(200);
    const resumed = resume.json();
    expect(resumed).toMatchObject({
      status: 'idle',
      project_id: 'project',
      paused: false,
      paused_at: null,
      queue: expect.any(Array),
      running_processes: expect.any(Array),
    });
    expect(readRuntimeState(root)).toMatchObject({ status: 'idle', paused: false, paused_at: null });
  });

  it('persists empty-body pause and resume transitions across server reinitialization', async () => {
    const pause = await server.fastify.inject({ method: 'POST', url: '/api/runtime/pause', headers: { 'content-type': 'application/json' } });
    expect(pause.statusCode).toBe(200);
    await server.stop();
    server = await createServer(root, false);

    const pausedState = await server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(pausedState.statusCode).toBe(200);
    expect(pausedState.json().runtime).toMatchObject({ status: 'paused', paused: true, paused_at: expect.any(String) });

    const resume = await server.fastify.inject({ method: 'POST', url: '/api/runtime/resume', headers: { 'content-type': 'application/json' } });
    expect(resume.statusCode).toBe(200);
    await server.stop();
    server = await createServer(root, false);

    const resumedState = await server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(resumedState.statusCode).toBe(200);
    expect(resumedState.json().runtime).toMatchObject({ status: 'idle', paused: false, paused_at: null });
  });

  it('returns card-runs typed union shape', async () => {
    updateRuntimeState(root, { status: 'running', active_card_run: { card_id: 'goal-a', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: null, caller_tool_call_id: null, planner_session_id: 'planner:goal-a', correction_attempts: 0, started_at: new Date().toISOString(), last_turn_at: new Date().toISOString() } });
    const response = await server.fastify.inject({ method: 'GET', url: '/api/runtime/card-runs' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.active_card_run.card_id).toBe('goal-a');
    expect(body.active_breadcrumb[0]).toMatchObject({ card_id: 'project', card_type: 'project', title: expect.any(String) });
    expect(Array.isArray(body.dormant_planners)).toBe(true);
    expect(Array.isArray(body.cards_with_pending_corrections)).toBe(true);
  });
});

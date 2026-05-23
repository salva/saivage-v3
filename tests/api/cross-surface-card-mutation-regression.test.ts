import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { WebSocket } from 'ws';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSession } from '../../src/agents/session-persistence.js';
import { resetWebSocketState, registerWebSocket } from '../../src/server/websocket.js';
import { recordControlAction } from '../../src/persistence/control-action-audit.js';
import { getAuthPolicy, resetAuthPolicyForTests } from '../../src/server/auth-policy.js';

const TEST_ROOT = join(tmpdir(), `saivage-cross-surface-${Date.now()}`);
const authToken = 'test-token';
const secretLiteral = 'apiKey="secret-cross-surface-123" token="top-secret"';
let app: FastifyInstance;
let port: number;
let executorSessionId = '';

function authHeader(token?: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

function initializeProjectRoot(root: string): void {
  const saivageDir = join(root, '.saivage');
  mkdirSync(join(saivageDir, 'cards', 'by-id'), { recursive: true });
  mkdirSync(join(saivageDir, 'cards', 'tree'), { recursive: true });
  mkdirSync(join(saivageDir, 'cards', 'dependencies'), { recursive: true });
  mkdirSync(join(saivageDir, 'notes', 'by-card'), { recursive: true });
  mkdirSync(join(saivageDir, 'runtime'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(saivageDir, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, version_seq: 1 }));
  writeFileSync(join(saivageDir, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(saivageDir, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(saivageDir, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
}

function openWebSocketEvents(): Promise<{ socket: WebSocket; events: Array<{ type: string; content: Record<string, unknown> }> }> {
  return new Promise((resolve, reject) => {
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const socket = new WebSocket(`${url('/ws')}?ticket=${ticket}`);
    const events: Array<{ type: string; content: Record<string, unknown> }> = [];
    const timer = setTimeout(() => reject(new Error('Timed out waiting for websocket connection')), 5000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve({ socket, events });
    });
    socket.on('message', (raw) => {
      const parsed = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
      events.push(parsed);
    });
    socket.once('error', reject);
  });
}

async function waitForActivityCount(events: Array<{ type: string; content: Record<string, unknown> }>, count: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (events.filter((entry) => entry.type === 'activity').length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${count} activity websocket events; saw ${events.length}`);
}

beforeAll(async () => {
  process.env['SAIVAGE_API_TOKEN'] = authToken;
  resetAuthPolicyForTests();
  initializeProjectRoot(TEST_ROOT);
  const saivageDir = join(TEST_ROOT, '.saivage');
  createSession(saivageDir, 'planner', 'goal-1', null);
  const executor = createSession(saivageDir, 'executor', 'goal-1', 'code-1');
  executorSessionId = executor.id;

  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const { default: authPlugin } = await import('../../src/server/auth.js');
  await app.register(authPlugin);
  const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
  const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
  registerCardRoutes(app, TEST_ROOT);
  registerRuntimeConfigNotesRoutes(app, TEST_ROOT);
  registerWebSocket(app, TEST_ROOT);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;

  await fetch(url('/api/cards'), {
    method: 'POST',
    headers: { ...authHeader(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'goal-1', title: 'Tracked goal', type: 'goal', parent: 'project', acceptance: 'goal acceptance' }),
  });
  await fetch(url('/api/cards'), {
    method: 'POST',
    headers: { ...authHeader(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dependency-1', title: 'Dependency card', type: 'task', parent: 'goal-1', acceptance: 'dependency acceptance' }),
  });
  await fetch(url('/api/cards'), {
    method: 'POST',
    headers: { ...authHeader(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'code-1', title: 'Tracked card', type: 'code', parent: 'goal-1', description: 'before', acceptance: 'accept initial' }),
  });
}, 30000);

afterAll(async () => {
  resetWebSocketState(TEST_ROOT);
  await app.close();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('cross-surface card mutation regression', () => {
  it('tracks one canonical blocking mutation across history, audit, notifications, REST, websocket, and redaction boundaries', async () => {
    const { socket, events } = await openWebSocketEvents();
    try {
      const mutateRes = await fetch(url('/api/cards/code-1'), {
        method: 'PATCH',
        headers: { ...authHeader(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ description: secretLiteral, acceptance: `accept updated ${secretLiteral}` }),
      });
      expect(mutateRes.status).toBe(200);
      const mutated = await mutateRes.json() as { card: { version_seq: number; description: string; acceptance: string } };
      expect(mutated.card.version_seq).toBe(2);
      expect(mutated.card.description).toContain('secret-cross-surface-123');

      await waitForActivityCount(events, 5);
      const activityEvents = events.filter((entry) => entry.type === 'activity');
      for (const event of activityEvents) {
        expect(JSON.stringify(event)).not.toContain('secret-cross-surface-123');
        expect(JSON.stringify(event)).not.toContain('top-secret');
      }

      const historyEvents = activityEvents.filter((entry) => entry.content['event'] === 'card_history_appended');
      expect(historyEvents).toHaveLength(1);
      expect(historyEvents[0]?.content).toMatchObject({ card_id: 'code-1', version_seq: 2, changed_fields: expect.arrayContaining(['description', 'acceptance']) });
      expect(Object.keys(historyEvents[0]?.content ?? {})).toEqual(expect.arrayContaining(['event', 'card_id', 'version_seq', 'changed_fields', 'changed_at']));

      const auditEvents = activityEvents.filter((entry) => entry.content['event'] === 'control_action_recorded');
      expect(auditEvents).toHaveLength(1);
      expect(auditEvents[0]?.content).toMatchObject({ action: 'card.update', target_kind: 'card', target_id: 'code-1', outcome: 'ok' });
      expect(Object.keys(auditEvents[0]?.content ?? {})).toEqual(expect.arrayContaining(['event', 'id', 'action', 'target_kind', 'target_id', 'outcome', 'created_at']));

      const notificationEvents = activityEvents.filter((entry) => entry.content['event'] === 'notification_added');
      expect(notificationEvents).toHaveLength(3);
      expect(notificationEvents.every((entry) => entry.content['kind'] === 'card_changed')).toBe(true);
      expect(notificationEvents.every((entry) => entry.content['severity'] === 'block')).toBe(true);
      expect(notificationEvents.every((entry) => entry.content['related_card_id'] === 'code-1')).toBe(true);
      expect(notificationEvents.every((entry) => entry.content['related_version_seq'] === 2)).toBe(true);
      for (const event of notificationEvents) {
        expect(Object.keys(event.content)).toEqual(expect.arrayContaining(['event', 'id', 'kind', 'severity', 'related_card_id', 'related_version_seq', 'created_at']));
      }

      const historyRes = await fetch(url('/api/cards/code-1/history'), { headers: authHeader(authToken) });
      expect(historyRes.status).toBe(200);
      const historyBody = await historyRes.json() as { total: number; history: Array<Record<string, unknown>> };
      expect(historyBody.total).toBe(1);
      expect(historyBody.history[0]?.['version_seq']).toBe(1);
      expect(historyBody.history[0]?.['snapshot']).toBeUndefined();
      expect(historyBody.history[0]?.['changed_fields']).toEqual(expect.arrayContaining(['description', 'acceptance']));
      expect(JSON.stringify(historyBody)).not.toContain('secret-cross-surface-123');

      const entryRes = await fetch(url('/api/cards/code-1/history/1'), { headers: authHeader(authToken) });
      expect(entryRes.status).toBe(200);
      const entryBody = await entryRes.json() as { entry: { snapshot: { description: string; acceptance: string } } };
      expect(entryBody.entry.snapshot.description).toBe('before');
      expect(entryBody.entry.snapshot.acceptance).toBe('accept initial');
      expect(JSON.stringify(entryBody)).not.toContain('secret-cross-surface-123');

      const diffRes = await fetch(url('/api/cards/code-1/diff?from=1&to=2'), { headers: authHeader(authToken) });
      expect(diffRes.status).toBe(200);
      const diffBody = await diffRes.json() as { diff: Array<{ field: string; before: unknown; after: unknown }> };
      expect(diffBody.diff.find((entry) => entry.field === 'description')).toBeDefined();
      expect(diffBody.diff.find((entry) => entry.field === 'acceptance')).toBeDefined();
      expect(JSON.stringify(diffBody)).not.toContain('secret-cross-surface-123');
      expect(JSON.stringify(diffBody)).not.toContain('top-secret');

      const notificationsRes = await fetch(url('/api/notifications'), { headers: authHeader(authToken) });
      expect(notificationsRes.status).toBe(200);
      const notificationsBody = await notificationsRes.json() as { notifications: Array<{ kind: string; severity: string; payload_summary: string; related_card_id: string; related_version_seq: number }> };
      const cardChangedOperatorNotifications = notificationsBody.notifications.filter((entry) => entry.kind === 'card_changed' && entry.related_card_id === 'code-1');
      expect(cardChangedOperatorNotifications).toHaveLength(1);
      expect(cardChangedOperatorNotifications[0]?.severity).toBe('block');
      expect(cardChangedOperatorNotifications[0]?.related_version_seq).toBe(2);
      expect(cardChangedOperatorNotifications[0]?.payload_summary).not.toContain('secret-cross-surface-123');
      expect(cardChangedOperatorNotifications[0]?.payload_summary).toContain('Use diff_card to inspect the change.');

      const controlActionsRes = await fetch(url('/api/control-actions?card_id=code-1'), { headers: authHeader(authToken) });
      expect(controlActionsRes.status).toBe(200);
      const controlActionsBody = await controlActionsRes.json() as { control_actions: Array<{ action: string; outcome: string; params_summary: string; target_id: string }> };
      const updateActions = controlActionsBody.control_actions.filter((entry) => entry.action === 'card.update' && entry.target_id === 'code-1');
      expect(updateActions).toHaveLength(1);
      expect(updateActions[0]?.outcome).toBe('ok');
      expect(updateActions[0]?.params_summary).not.toContain('secret-cross-surface-123');
      expect(updateActions[0]?.params_summary).not.toContain('top-secret');

      const rawSessionNotifications = readFileSync(join(TEST_ROOT, '.saivage', 'runtime', 'notifications', 'by-session', `${executorSessionId}.jsonl`), 'utf-8');
      expect(rawSessionNotifications).not.toContain('secret-cross-surface-123');
      expect(rawSessionNotifications).not.toContain('top-secret');

      recordControlAction(TEST_ROOT, {
        actor: 'analyst',
        surface: 'rest',
        action: 'runtime.pause',
        target_kind: 'runtime',
        target_id: 'project',
        params_summary: `manual ${secretLiteral}`,
        confirmed: true,
        outcome: 'ok',
        outcome_summary: `paused with ${secretLiteral}`,
      });
      const auditListRes = await fetch(url('/api/control-actions'), { headers: authHeader(authToken) });
      expect(auditListRes.status).toBe(200);
      expect(JSON.stringify(await auditListRes.json())).not.toContain('secret-cross-surface-123');
      expect(JSON.stringify(await fetch(url('/api/notifications'), { headers: authHeader(authToken) }).then((res) => res.json()))).not.toContain('secret-cross-surface-123');
    } finally {
      socket.close();
    }
  });

  it('keeps blocking-versus-warn notification severity consistent for critical versus lower-impact tracked fields', async () => {
    const { socket, events } = await openWebSocketEvents();
    try {
      const updateRes = await fetch(url('/api/cards/code-1'), {
        method: 'PATCH',
        headers: { ...authHeader(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ priority: 7 }),
      });
      expect(updateRes.status).toBe(200);
      const updated = await updateRes.json() as { card: { version_seq: number; priority: number } };
      expect(updated.card.version_seq).toBe(3);
      expect(updated.card.priority).toBe(7);

      await waitForActivityCount(events, 5);
      const activityEvents = events.filter((entry) => entry.type === 'activity');
      const notificationEvents = activityEvents.filter((entry) => entry.content['event'] === 'notification_added');
      expect(notificationEvents).toHaveLength(3);
      expect(notificationEvents.every((entry) => entry.content['severity'] === 'warn')).toBe(true);
      expect(notificationEvents.every((entry) => entry.content['related_version_seq'] === 3)).toBe(true);

      const notificationsRes = await fetch(url('/api/notifications'), { headers: authHeader(authToken) });
      expect(notificationsRes.status).toBe(200);
      const notificationsBody = await notificationsRes.json() as { notifications: Array<{ related_card_id: string; related_version_seq: number; severity: string }> };
      const warnNotification = notificationsBody.notifications.find((entry) => entry.related_card_id === 'code-1' && entry.related_version_seq === 3);
      expect(warnNotification?.severity).toBe('warn');

      const historyRes = await fetch(url('/api/cards/code-1/history'), { headers: authHeader(authToken) });
      const historyBody = await historyRes.json() as { total: number; history: Array<Record<string, unknown>> };
      expect(historyBody.total).toBe(2);
      expect(historyBody.history[0]?.['changed_fields']).toEqual(['priority']);

      const controlActionsRes = await fetch(url('/api/control-actions?card_id=code-1'), { headers: authHeader(authToken) });
      const controlActionsBody = await controlActionsRes.json() as { control_actions: Array<{ action: string; outcome: string; target_id: string }> };
      expect(controlActionsBody.control_actions.filter((entry) => entry.action === 'card.update' && entry.outcome === 'ok' && entry.target_id === 'code-1')).toHaveLength(2);

      const rawSessionNotifications = readFileSync(join(TEST_ROOT, '.saivage', 'runtime', 'notifications', 'by-session', `${executorSessionId}.jsonl`), 'utf-8');
      expect(rawSessionNotifications).not.toContain('secret-cross-surface-123');
    } finally {
      socket.close();
    }
  });

  it('treats instructions_file and depends_on mutations as blocking across websocket and REST surfaces', async () => {
    const instructionsSocketState = await openWebSocketEvents();
    try {
      const instructionsRes = await fetch(url('/api/cards/code-1'), {
        method: 'PATCH',
        headers: { ...authHeader(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ instructions_file: 'docs/runbook.md' }),
      });
      expect(instructionsRes.status).toBe(200);
      const instructionsBody = await instructionsRes.json() as { card: { version_seq: number; instructions_file: string } };
      expect(instructionsBody.card.version_seq).toBe(4);
      expect(instructionsBody.card.instructions_file).toBe('docs/runbook.md');

      await waitForActivityCount(instructionsSocketState.events, 5);
      const instructionsActivity = instructionsSocketState.events.filter((entry) => entry.type === 'activity');
      const instructionsNotifications = instructionsActivity.filter((entry) => entry.content['event'] === 'notification_added');
      expect(instructionsNotifications).toHaveLength(3);
      expect(instructionsNotifications.every((entry) => entry.content['severity'] === 'block')).toBe(true);
      expect(instructionsNotifications.every((entry) => entry.content['related_card_id'] === 'code-1')).toBe(true);
      expect(instructionsNotifications.every((entry) => entry.content['related_version_seq'] === 4)).toBe(true);

      const instructionsHistoryEvent = instructionsActivity.find((entry) => entry.content['event'] === 'card_history_appended');
      expect(instructionsHistoryEvent?.content).toMatchObject({
        card_id: 'code-1',
        version_seq: 4,
        changed_fields: ['instructions_file'],
      });

      const instructionsNotificationsRes = await fetch(url('/api/notifications'), { headers: authHeader(authToken) });
      expect(instructionsNotificationsRes.status).toBe(200);
      const instructionsNotificationsBody = await instructionsNotificationsRes.json() as { notifications: Array<{ related_card_id: string; related_version_seq: number; severity: string; payload_summary: string }> };
      const instructionsOperatorNotification = instructionsNotificationsBody.notifications.find((entry) => entry.related_card_id === 'code-1' && entry.related_version_seq === 4);
      expect(instructionsOperatorNotification?.severity).toBe('block');
      expect(instructionsOperatorNotification?.payload_summary).toContain('instructions_file');

      const instructionsHistoryRes = await fetch(url('/api/cards/code-1/history'), { headers: authHeader(authToken) });
      expect(instructionsHistoryRes.status).toBe(200);
      const instructionsHistoryBody = await instructionsHistoryRes.json() as { total: number; history: Array<Record<string, unknown>> };
      expect(instructionsHistoryBody.total).toBe(3);
      expect(instructionsHistoryBody.history[0]?.['version_seq']).toBe(3);
      expect(instructionsHistoryBody.history[0]?.['changed_fields']).toEqual(['instructions_file']);

      const instructionsEntryRes = await fetch(url('/api/cards/code-1/history/3'), { headers: authHeader(authToken) });
      expect(instructionsEntryRes.status).toBe(200);
      const instructionsEntryBody = await instructionsEntryRes.json() as { entry: { snapshot: { instructions_file: string | null } } };
      expect(instructionsEntryBody.entry.snapshot.instructions_file).toBeNull();

      const instructionsDiffRes = await fetch(url('/api/cards/code-1/diff?from=3&to=4'), { headers: authHeader(authToken) });
      expect(instructionsDiffRes.status).toBe(200);
      const instructionsDiffBody = await instructionsDiffRes.json() as { diff: Array<{ field: string; before: unknown; after: unknown }> };
      expect(instructionsDiffBody.diff).toContainEqual({ field: 'instructions_file', before: null, after: 'docs/runbook.md' });

      const instructionsAuditRes = await fetch(url('/api/control-actions?card_id=code-1'), { headers: authHeader(authToken) });
      expect(instructionsAuditRes.status).toBe(200);
      const instructionsAuditBody = await instructionsAuditRes.json() as { control_actions: Array<{ action: string; target_id: string; outcome: string; params_summary: string }> };
      const instructionsUpdateAction = instructionsAuditBody.control_actions.find((entry) => entry.action === 'card.update' && entry.target_id === 'code-1' && entry.params_summary.includes('instructions_file'));
      expect(instructionsUpdateAction?.outcome).toBe('ok');
    } finally {
      instructionsSocketState.socket.close();
    }

    const dependsOnSocketState = await openWebSocketEvents();
    try {
      const dependsOnRes = await fetch(url('/api/cards/code-1'), {
        method: 'PATCH',
        headers: { ...authHeader(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ depends_on: ['dependency-1'] }),
      });
      expect(dependsOnRes.status).toBe(200);
      const dependsOnBody = await dependsOnRes.json() as { card: { version_seq: number; depends_on: string[] } };
      expect(dependsOnBody.card.version_seq).toBe(5);
      expect(dependsOnBody.card.depends_on).toEqual(['dependency-1']);

      await waitForActivityCount(dependsOnSocketState.events, 5);
      const dependsOnActivity = dependsOnSocketState.events.filter((entry) => entry.type === 'activity');
      const dependsOnNotifications = dependsOnActivity.filter((entry) => entry.content['event'] === 'notification_added');
      expect(dependsOnNotifications).toHaveLength(3);
      expect(dependsOnNotifications.every((entry) => entry.content['severity'] === 'block')).toBe(true);
      expect(dependsOnNotifications.every((entry) => entry.content['related_card_id'] === 'code-1')).toBe(true);
      expect(dependsOnNotifications.every((entry) => entry.content['related_version_seq'] === 5)).toBe(true);

      const dependsOnNotificationsRes = await fetch(url('/api/notifications'), { headers: authHeader(authToken) });
      expect(dependsOnNotificationsRes.status).toBe(200);
      const dependsOnNotificationsBody = await dependsOnNotificationsRes.json() as { notifications: Array<{ related_card_id: string; related_version_seq: number; severity: string; payload_summary: string }> };
      const dependsOnOperatorNotification = dependsOnNotificationsBody.notifications.find((entry) => entry.related_card_id === 'code-1' && entry.related_version_seq === 5);
      expect(dependsOnOperatorNotification?.severity).toBe('block');
      expect(dependsOnOperatorNotification?.payload_summary).toContain('depends_on');

      const rawSessionNotifications = readFileSync(join(TEST_ROOT, '.saivage', 'runtime', 'notifications', 'by-session', `${executorSessionId}.jsonl`), 'utf-8');
      expect(rawSessionNotifications).not.toContain('secret-cross-surface-123');
      expect(rawSessionNotifications).not.toContain('top-secret');
    } finally {
      dependsOnSocketState.socket.close();
    }
  });
});

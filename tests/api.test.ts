import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getClientCount } from '../src/server/websocket.js';
import { resetChatRouteState } from '../src/server/routes/chats-files-debug.js';
import { appendNote } from '../src/utils/notes.js';
import { createServer, type ServerInstance } from '../src/server/server.js';
import { NotificationCenter } from '../src/utils/notification-center.js';
import { recordControlAction } from '../src/utils/control-action-audit.js';
import { runtimeStatePath } from '../src/runtime/state.js';
import { getAuthPolicy, resetAuthPolicyForTests } from '../src/server/auth-policy.js';

const TEST_ROOT = join(tmpdir(), `saivage-api-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');

let app: FastifyInstance;
let port: number;
let authToken: string;

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
  mkdirSync(join(saivageDir, 'tmp', 'state'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(saivageDir, 'agents', 'messages'), { recursive: true });

  const now = new Date().toISOString();
  writeFileSync(join(saivageDir, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, version_seq: 1 }));
  writeFileSync(join(saivageDir, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(saivageDir, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(runtimeStatePath(root), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify({ server: { port: 0, host: '127.0.0.1' }, models: { default: ['test-model'] }, providers: { test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' } } }));
}

async function waitForWsEvent(ws: WebSocket, eventName: string): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`Timed out waiting for websocket event ${eventName}`));
    }, 1000);
    const onMessage = (raw: WebSocket.RawData) => {
      const parsed = JSON.parse(Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw)) as { type: string; content: Record<string, unknown> };
      if (parsed.content?.event === eventName) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(parsed.content);
      }
    };
    ws.on('message', onMessage);
  });
}

beforeAll(async () => {
  initializeProjectRoot(TEST_ROOT);

  authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
  process.env['SAIVAGE_API_TOKEN'] = authToken;
  resetAuthPolicyForTests();

  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const { default: authPlugin } = await import('../src/server/auth.js');
  await app.register(authPlugin);
  const { registerCardRoutes } = await import('../src/server/routes/cards.js');
  const { registerRuntimeConfigNotesRoutes } = await import('../src/server/routes/runtime-config-notes.js');
  const { registerChatsFilesDebugRoutes } = await import('../src/server/routes/chats-files-debug.js');
  const { registerWebSocket } = await import('../src/server/websocket.js');
  registerCardRoutes(app, TEST_ROOT);
  registerRuntimeConfigNotesRoutes(app, TEST_ROOT);
  registerChatsFilesDebugRoutes(app, TEST_ROOT);
  registerWebSocket(app, TEST_ROOT);
  const { readRuntimeState } = await import('../src/runtime/state.js');
  app.get('/health', async (_req, reply) => {
    const state = readRuntimeState(TEST_ROOT);
    return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: state?.status ?? 'unknown' });
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
  await app.close();
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch {}
}, 10000);

describe('card detail planning summary semantics', () => {
  it('returns the canonical card payload for a persisted goal card', async () => {
    const now = new Date().toISOString();
    const cardId = 'goal-planning-semantics';
    const cardPath = join(SAIVAGE_DIR, 'cards', 'by-id', `${cardId}.json`);
    const indexPath = join(SAIVAGE_DIR, 'cards', 'index.json');
    const projectChildrenPath = join(SAIVAGE_DIR, 'cards', 'tree', 'project.children.json');
    const cardChildrenPath = join(SAIVAGE_DIR, 'cards', 'tree', `${cardId}.children.json`);

    writeFileSync(cardPath, JSON.stringify({
      id: cardId,
      type: 'goal',
      parent: 'project',
      depth: 1,
      title: 'Planning semantics goal',
      description: 'Tests canonical card reads.',
      status: 'done',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      created_at: now,
      updated_at: now,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
      version_seq: 1,
      result: {
        planning: {
          status: 'continue',
          review_summary: 'Looks complete from review/status heuristics.',
          planner_declared_done: true,
          has_unfinished_child_work: true,
          created_cards: [],
        },
      },
    }));

    writeFileSync(indexPath, JSON.stringify({
      cards: {
        project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' },
        [cardId]: { id: cardId, type: 'goal', parent: 'project', status: 'done', title: 'Planning semantics goal' },
      },
    }));
    writeFileSync(projectChildrenPath, JSON.stringify([cardId]));
    writeFileSync(cardChildrenPath, JSON.stringify([]));

    const res = await fetch(url(`/api/cards/${cardId}`), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { card: { id: string; result?: Record<string, unknown> } };
    expect(body.card.id).toBe(cardId);
    expect(body.card.result).toEqual(expect.objectContaining({ planning: expect.objectContaining({ status: 'continue' }) }));
  });
});

describe('runtime config and notes routes', () => {
  it('rejects generic resume from frozen state with actionable 400', async () => {
    const now = new Date().toISOString();
    writeFileSync(runtimeStatePath(TEST_ROOT), JSON.stringify({ status: 'frozen', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: true, paused_at: now, queue: [], running_processes: [], updated_at: now, frozen_reason: 'maintenance' }));
    const res = await fetch(url('/api/runtime/resume'), { method: 'POST', headers: authHeader(authToken) });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string; message: string; action: string };
    expect(body.error).toBe('Runtime is frozen');
    expect(body.message).toContain('/api/runtime/resume-from-freeze');
    expect(body.action).toBe('resume-from-freeze');
  });

  it('allows generic resume from paused state', async () => {
    const now = new Date().toISOString();
    writeFileSync(runtimeStatePath(TEST_ROOT), JSON.stringify({ status: 'paused', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: true, paused_at: now, queue: [], running_processes: [], updated_at: now }));
    const res = await fetch(url('/api/runtime/resume'), { method: 'POST', headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'idle', project_id: 'project', paused: false, paused_at: null });
    expect(Array.isArray(body['queue'])).toBe(true);
    expect(Array.isArray(body['running_processes'])).toBe(true);
    const state = JSON.parse(readFileSync(runtimeStatePath(TEST_ROOT), 'utf-8')) as { status: string; paused: boolean; paused_at: string | null };
    expect(state.status).toBe('idle');
    expect(state.paused).toBe(false);
    expect(state.paused_at).toBeNull();
  });

  it('returns actionable 503 when pause is requested without runtime state', async () => {
    unlinkSync(runtimeStatePath(TEST_ROOT));
    const res = await fetch(url('/api/runtime/pause'), { method: 'POST', headers: authHeader(authToken) });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('Runtime state is unavailable');
    expect(body.message).toContain('Start the runtime or initialize runtime state first');
  });

  it('returns actionable 503 when resume is requested without runtime state', async () => {
    const res = await fetch(url('/api/runtime/resume'), { method: 'POST', headers: authHeader(authToken) });
    expect(res.status).toBe(503);
    const body = await res.json() as { error: string; message: string };
    expect(body.error).toBe('Runtime state is unavailable');
    expect(body.message).toContain('Start the runtime or restore runtime state first');

    const now = new Date().toISOString();
    writeFileSync(runtimeStatePath(TEST_ROOT), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
  });



  it('includes route-local CardStore health on state reads after card index construction', async () => {
    const now = new Date().toISOString();
    writeFileSync(runtimeStatePath(TEST_ROOT), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));

    const treePath = join(SAIVAGE_DIR, 'cards', 'tree', 'project.children.json');
    writeFileSync(treePath, JSON.stringify(['missing-synthetic-child'], null, 2));

    const first = await fetch(url('/api/state'), { headers: authHeader(authToken) });
    expect(first.status).toBe(200);
    const firstBody = await first.json() as { cardStoreHealth?: { compatibilitySnapshots: string; warnings: unknown[]; lastCompatibilitySnapshotWarning?: { message: string; relativePath?: string } | null } };
    expect(firstBody.cardStoreHealth?.compatibilitySnapshots).toBe('ok');
    expect(firstBody.cardStoreHealth?.warnings).toEqual([]);
    expect(JSON.stringify(firstBody.cardStoreHealth)).not.toContain(TEST_ROOT);
    expect(JSON.stringify(firstBody.cardStoreHealth)).not.toContain('test-token');

    const second = await fetch(url('/api/state'), { headers: authHeader(authToken) });
    const secondBody = await second.json() as typeof firstBody;
    expect(secondBody.cardStoreHealth).toEqual(firstBody.cardStoreHealth);

    writeFileSync(treePath, JSON.stringify([], null, 2));
  });

  it('lists notes without returning note undefined and reconciles stale queue entries', async () => {
    appendNote(SAIVAGE_DIR, 'project', { author: 'user', content: 'Real note', kind: 'comment' });
    const queuePath = join(SAIVAGE_DIR, 'notes', 'queue.json');
    const queue = JSON.parse(readFileSync(queuePath, 'utf-8')) as { next_note_sequence: number; entries: Array<Record<string, unknown>> };
    queue.entries.push({ card_id: 'missing-card', note_id: 'n-missing-card-999', timestamp: new Date().toISOString(), kind: 'comment' });
    writeFileSync(queuePath, JSON.stringify(queue, null, 2) + '\n');

    const res = await fetch(url('/api/notes'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { notes: Array<{ note: { content: string } }>; total: number };
    expect(body.total).toBe(1);
    expect(body.notes[0].note.content).toBe('Real note');
    expect(JSON.parse(readFileSync(queuePath, 'utf-8'))).toEqual({ next_note_sequence: 2, entries: [expect.objectContaining({ card_id: 'project' })] });
  });

  it('does not allow a stale deleted note id to target a newly created note', async () => {
    const queuePath = join(SAIVAGE_DIR, 'notes', 'queue.json');
    writeFileSync(queuePath, JSON.stringify({ next_note_sequence: 1, entries: [] }, null, 2) + '\n');
    const notesPath = join(SAIVAGE_DIR, 'notes', 'by-card', 'project.jsonl');
    if (existsSync(notesPath)) {
      unlinkSync(notesPath);
    }

    const first = appendNote(SAIVAGE_DIR, 'project', { author: 'user', content: 'First note', kind: 'comment' });
    const deleteRes = await fetch(url(`/api/notes/${encodeURIComponent(first.id)}`), { method: 'DELETE', headers: authHeader(authToken) });
    expect(deleteRes.status).toBe(204);

    const replacement = appendNote(SAIVAGE_DIR, 'project', { author: 'user', content: 'Replacement note', kind: 'comment' });
    expect(replacement.id).not.toBe(first.id);

    const staleDelete = await fetch(url(`/api/notes/${encodeURIComponent(first.id)}`), { method: 'DELETE', headers: authHeader(authToken) });
    expect(staleDelete.status).toBe(404);

    const listRes = await fetch(url('/api/notes'), { headers: authHeader(authToken) });
    const body = await listRes.json() as { notes: Array<{ note_id: string; note: { content: string } }> };
    expect(body.notes.some((note) => note.note_id === replacement.id && note.note.content === 'Replacement note')).toBe(true);
    expect(body.notes.some((note) => note.note_id === first.id)).toBe(false);
  });

  it('reconciles malformed persisted queue to a valid empty queue', async () => {
    writeFileSync(join(SAIVAGE_DIR, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [{ card_id: 'project' }] }) + '\n');
    const res = await fetch(url('/api/notes'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { notes: Array<unknown>; total: number };
    expect(body.total).toBe(0);
    expect(body.notes).toEqual([]);
  });
});

describe('websocket push events', () => {
  it('broadcasts card history, notification add/ack, and control action events within one tick of mutations', async () => {
    const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?ticket=${ticket}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('message', () => resolve());
      ws.once('error', reject);
    });

    const createRes = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'WS card', type: 'code', parent: 'project', acceptance: 'old' }),
    });
    expect(createRes.status).toBe(201);

    const cardHistoryPromise = waitForWsEvent(ws, 'card_history_appended');
    const updateRes = await fetch(url('/api/cards/code-1'), {
      method: 'PATCH',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ acceptance: 'new acceptance', description: 'changed' }),
    });
    expect(updateRes.status).toBe(200);
    const cardHistoryEvent = await cardHistoryPromise;
    expect(cardHistoryEvent['card_id']).toBe('code-1');
    expect(cardHistoryEvent['version_seq']).toBe(2);

    const center = new NotificationCenter(TEST_ROOT);
    const notificationAddedPromise = waitForWsEvent(ws, 'notification_added');
    center.enqueueForOperator({ id: 'ws-notif', kind: 'runtime_state', severity: 'warn', payload_summary: 'pause notice', source_actor: 'analyst', source_surface: 'rest' });
    const notificationAdded = await notificationAddedPromise;
    expect(notificationAdded['id']).toBe('ws-notif');

    const notificationAckPromise = waitForWsEvent(ws, 'notification_acknowledged');
    const ackRes = await fetch(url('/api/notifications/ws-notif/acknowledge'), { method: 'POST', headers: authHeader(authToken) });
    expect(ackRes.status).toBe(200);
    const notificationAck = await notificationAckPromise;
    expect(notificationAck['id']).toBe('ws-notif');

    const controlActionPromise = waitForWsEvent(ws, 'control_action_recorded');
    recordControlAction(TEST_ROOT, { actor: 'analyst', surface: 'rest', action: 'runtime.pause', target_kind: 'runtime', target_id: 'project', params_summary: 'pause', confirmed: true, outcome: 'ok', outcome_summary: 'paused' });
    const controlActionEvent = await controlActionPromise;
    expect(controlActionEvent['action']).toBe('runtime.pause');

    ws.close();
  });
});

describe('server factory docs and lifecycle cleanup', () => {
  it('isolates /docs from the SPA fallback', async () => {
    const docsRoot = join(tmpdir(), `saivage-api-docs-${Date.now()}`);
    initializeProjectRoot(docsRoot);

    let server: ServerInstance | undefined;
    try {
      server = await createServer(docsRoot, false);
      await server.fastify.listen({ port: 0, host: '127.0.0.1' });
      const localPort = (server.fastify.server.address() as { port: number }).port;

      const res = await fetch(`http://127.0.0.1:${localPort}/docs`, {
        headers: authHeader(authToken),
        redirect: 'manual',
      });

      expect([302, 404]).toContain(res.status);
      if (res.status === 302) {
        expect(res.headers.get('location')).toBe('/docs/');
      } else {
        expect(await res.json()).toEqual({
          error: 'Documentation not built. Run vitepress build docs/ to generate.',
        });
      }
    } finally {
      try { await server?.stop(); } catch {}
      try { rmSync(docsRoot, { recursive: true, force: true }); } catch {}
    }
  });

  it('server.stop() runs route cleanup and closes websocket clients for createServer()', async () => {
    const lifecycleRoot = join(tmpdir(), `saivage-api-lifecycle-${Date.now()}`);
    initializeProjectRoot(lifecycleRoot);

    let server: ServerInstance | undefined;
    let ws: WebSocket | undefined;

    try {
      server = await createServer(lifecycleRoot, false);
      await server.fastify.listen({ port: 0, host: '127.0.0.1' });
      const localPort = (server.fastify.server.address() as { port: number }).port;

      const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
      ws = new WebSocket(`ws://127.0.0.1:${localPort}/ws?ticket=${ticket}`);
      await new Promise<void>((resolve, reject) => {
        ws!.once('message', () => resolve());
        ws!.once('error', reject);
      });

      const chatRes = await fetch(`http://127.0.0.1:${localPort}/api/chats/lifecycle-close`, {
        method: 'POST',
        headers: { ...authHeader(authToken), 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'list all cards' }),
      });
      expect(chatRes.status).toBeGreaterThanOrEqual(200);
      expect(chatRes.status).toBeLessThan(500);
      expect(getClientCount()).toBeGreaterThan(0);

      await server.stop();
      server = undefined;
      ws = undefined;
      expect(getClientCount()).toBe(0);
    } finally {
      try { ws?.terminate(); } catch {}
      try { await server?.stop(); } catch {}
      try { resetChatRouteState(lifecycleRoot); } catch {}
      try { rmSync(lifecycleRoot, { recursive: true, force: true }); } catch {}
    }
  }, 10000);
});

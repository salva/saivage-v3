import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../src/utils/card-store.js';
import { initRuntimeState, readRuntimeState, updateRuntimeState } from '../src/utils/runtime-state.js';
import { startProcess, waitProcess } from '../src/utils/process-runner.js';

import {
  create_card, edit_card, move_card, delete_card, add_note,
  list_cards, get_card, get_tree, get_plan_diary, get_status,
  pause_runtime, resume_runtime, abort_goal, restart_card,
  restart_goal, kill_process,
} from '../src/agents/analyst-tools.js';
import type { ToolContext } from '../src/agents/analyst-tools.js';

import { AnalystHandler, getOrCreateAnalystSession } from '../src/agents/analyst-handler.js';
import { ANALYST_TOOL_DEFINITIONS } from '../src/agents/analyst-tool-schemas.js';

function uniqueDir(): string {
  return join(tmpdir(), `saivage-analyst-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages','diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    server: { port: 0, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: { test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' } },
  }));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({
    id: 'project', type: 'project', parent: null, depth: 0, title: 'project',
    description: '', status: 'backlog', subtype: null, tags: [], priority: 0,
    urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now,
    assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '',
    result: null, metrics: null, artifacts: [], attachments: [], estimate: null,
    started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0,
  }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({
    cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } },
  }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));
  initRuntimeState(projectRoot);
}

function setupTestProject(projectRoot: string): CardStore {
  setupProject(projectRoot);
  const store = new CardStore(projectRoot);
  store.create({
    type: 'goal', parent: 'project', title: 'Test Goal', description: 'A test goal',
    status: 'active', depth: 0, tags: [], priority: 1, urgency: 'normal', created_by: 'analyst',
    acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [],
    attachments: [], retries: 0, id: 'goal-1',
  });
  store.activateGoal('goal-1');
  store.create({
    type: 'code', parent: 'goal-1', title: 'Code Task 1', description: 'Implement feature',
    status: 'backlog', depth: 0, tags: ['code'], priority: 2, urgency: 'normal',
    created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [],
    artifacts: [], attachments: [], retries: 0, id: 'code-1',
  });
  store.create({
    type: 'test', parent: 'goal-1', title: 'Test Task 1', description: 'Write tests',
    status: 'backlog', depth: 0, tags: ['test'], priority: 3, urgency: 'normal',
    created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [],
    artifacts: [], attachments: [], retries: 0, id: 'test-1',
  });
  return store;
}

function ctx(projectRoot: string, store?: CardStore): ToolContext {
  return { projectRoot, store };
}

describe('Analyst Tool Definitions', () => {
  it('do not advertise removed plan card types', () => {
    const toolText = JSON.stringify(ANALYST_TOOL_DEFINITIONS);
    expect(toolText).not.toContain('goal, plan');
    expect(toolText).not.toContain('project, goal, plan');
    expect(toolText).toContain('Non-terminal type: goal');
  });
});

describe('Analyst Tools', () => {
  let projectRoot: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = uniqueDir();
    store = setupTestProject(projectRoot);
  });
  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates a card under goal, returns success with card data', async () => {
    const r = await create_card(ctx(projectRoot, store), { type: 'code', parent: 'goal-1', title: 'New Code Card', description: 'A new card' });
    expect(r.success).toBe(true);
    const c = r.data as Record<string, unknown>;
    expect(c.title).toBe('New Code Card');
    expect(c.parent).toBe('goal-1');
    expect(c.type).toBe('code');
    expect(c.id).toMatch(/^code-/);
  });

  it('returns preview for kill_process existing process', async () => {
    const proc = startProcess(projectRoot, 'true', { cardId: 'code-1' });
    await waitProcess(projectRoot, proc.id, 1000);
    const r = await kill_process(ctx(projectRoot, store), { processId: proc.id });
    expect(r.success).toBe(true);
    expect(r.preview).toBeDefined();
  });

  it('refuses resume_runtime while frozen and preserves frozen persisted state', async () => {
    updateRuntimeState(projectRoot, {
      status: 'frozen',
      paused: true,
      paused_at: '2025-01-01T00:00:00.000Z',
      frozen_reason: 'operator requested freeze',
    });

    const before = readRuntimeState(projectRoot);
    expect(before).not.toBeNull();
    expect(before?.status).toBe('frozen');

    const result = await resume_runtime(ctx(projectRoot, store), {});

    expect(result.success).toBe(false);
    expect(result.error).toContain('resume-from-freeze');
    expect(result.error).toContain('Runtime is frozen');

    const after = readRuntimeState(projectRoot);
    expect(after).not.toBeNull();
    expect(after?.status).toBe('frozen');
    expect(after?.paused).toBe(true);
    expect(after?.paused_at).toBe('2025-01-01T00:00:00.000Z');
    expect(after?.frozen_reason).toBe('operator requested freeze');
    expect(after).toEqual(before);
  });
});

describe('Analyst Handler', () => {
  let projectRoot: string;
  let store: CardStore;

  beforeEach(() => {
    projectRoot = uniqueDir();
    store = setupTestProject(projectRoot);
  });
  afterEach(() => {
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  });

  it('creates and reuses analyst sessions', () => {
    const first = getOrCreateAnalystSession(projectRoot);
    const second = getOrCreateAnalystSession(projectRoot);
    expect(first.sessionId).toBe('analyst');
    expect(second.session.started_at).toBe(first.session.started_at);
  });

  it('deduplicates the same chat message when two transports submit it together', async () => {
    const handler = new AnalystHandler(projectRoot);
    const first = await handler.handleMessage('s16', 'list all cards');
    const second = await handler.handleMessage('s16', 'list all cards');
    expect(second.message.content).toBe(first.message.content);
  });
});

describe('API Chat and WebSocket Integration', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupTestProject(projectRoot);
    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }, 10000);

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }
  function wsUrl(): string {
    return `ws://127.0.0.1:${port}/ws?token=${authToken}`;
  }
  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  it('returns a real analyst response message', async () => {
    const res = await fetch(apiUrl('/api/chats/chat-int-1'), {
      method: 'POST',
      headers: { ...authHdr(), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'list all cards' }),
    });
    expect(res.status).toBe(200);
  });

  it('sending a message via WebSocket returns a real analyst response', (done) => {
    const ws = new WebSocket(wsUrl());
    let welcomed = false;
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
      if (!welcomed && data.content.event === 'connected') {
        welcomed = true;
        ws.send(JSON.stringify({ type: 'message', content: { text: 'list all cards' } }));
        return;
      }
      if (welcomed && data.type === 'message') {
        expect(data.content.content).toBeTruthy();
        ws.close();
        done();
      }
    });
    ws.on('error', (err) => { ws.close(); done(err); });
  }, 15000);

  it('keeps websocket analyst handlers scoped to each project root', async () => {
    const otherRoot = uniqueDir();
    setupTestProject(otherRoot);
    const otherApp = Fastify({ logger: false });
    const mainMessagesPath = join(projectRoot, '.saivage', 'agents', 'messages', 'analyst.jsonl');
    const beforeMainMessages = existsSync(mainMessagesPath) ? readFileSync(mainMessagesPath, 'utf-8') : '';

    try {
      await otherApp.register(cors);
      await otherApp.register(websocket);
      const { default: authPlugin } = await import('../src/server/auth.js');
      await otherApp.register(authPlugin);
      const { registerCardRoutes } = await import('../src/server/routes/cards.js');
      const { registerRuntimeConfigNotesRoutes } = await import('../src/server/routes/runtime-config-notes.js');
      const { registerChatsFilesDebugRoutes } = await import('../src/server/routes/chats-files-debug.js');
      const { registerWebSocket } = await import('../src/server/websocket.js');

      registerCardRoutes(otherApp, otherRoot);
      registerRuntimeConfigNotesRoutes(otherApp, otherRoot);
      registerChatsFilesDebugRoutes(otherApp, otherRoot);
      registerWebSocket(otherApp, otherRoot);

      await otherApp.listen({ port: 0, host: '127.0.0.1' });
      const otherPort = (otherApp.server.address() as { port: number }).port;
      const ws = new WebSocket(`ws://127.0.0.1:${otherPort}/ws?token=${authToken}`);

      await new Promise<void>((resolve, reject) => {
        ws.once('message', () => resolve());
        ws.once('error', reject);
      });

      ws.send(JSON.stringify({ type: 'message', content: { text: 'list all cards' } }));
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Timed out waiting for websocket response')), 5000);
        ws.on('message', (raw) => {
          const data = JSON.parse(raw.toString()) as { type: string };
          if (data.type === 'message') {
            clearTimeout(timeout);
            resolve();
          }
        });
        ws.once('error', (err) => {
          clearTimeout(timeout);
          reject(err);
        });
      });
      ws.close();

      const afterMainMessages = existsSync(mainMessagesPath) ? readFileSync(mainMessagesPath, 'utf-8') : '';
      expect(existsSync(join(otherRoot, '.saivage', 'agents', 'messages', 'analyst.jsonl'))).toBe(true);
      expect(afterMainMessages).toBe(beforeMainMessages);
    } finally {
      try { await otherApp.close(); } catch {}
      try { rmSync(otherRoot, { recursive: true, force: true }); } catch {}
    }
  }, 15000);
});

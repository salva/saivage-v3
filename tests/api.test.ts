/**
 * Stage 6 — API and WebSocket Tests
 *
 * Tests cover all endpoints from 08-server-api.md plus WebSocket auth/events.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import WebSocket from 'ws';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Test Setup ────────────────────────────────────────────────

const TEST_ROOT = join(tmpdir(), `saivage-api-test-${Date.now()}`);
const SAIVAGE_DIR = join(TEST_ROOT, '.saivage');

let app: FastifyInstance;
let port: number;
let authToken: string;

function authHeader(token?: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}

beforeAll(async () => {
  // Set up test project tree
  mkdirSync(TEST_ROOT, { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'cards', 'by-id'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'cards', 'tree'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'cards', 'dependencies'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'notes', 'by-card'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'runtime'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'agents', 'sessions'), { recursive: true });
  mkdirSync(join(SAIVAGE_DIR, 'agents', 'messages'), { recursive: true });

  // Initialize card store
  const projectCard = {
    id: 'project',
    type: 'project',
    parent: null,
    depth: 0,
    title: 'project',
    description: '',
    status: 'backlog',
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
  };
  writeFileSync(
    join(SAIVAGE_DIR, 'cards', 'by-id', 'project.json'),
    JSON.stringify(projectCard, null, 2),
  );
  writeFileSync(
    join(SAIVAGE_DIR, 'cards', 'index.json'),
    JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }),
  );
  writeFileSync(join(SAIVAGE_DIR, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(SAIVAGE_DIR, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(SAIVAGE_DIR, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(SAIVAGE_DIR, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));

  // Initialize runtime state
  writeFileSync(
    join(SAIVAGE_DIR, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: new Date().toISOString(),
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: new Date().toISOString(),
    }),
  );

  // Create a minimal saivage.json (must include models section for loadConfig to pass)
  writeFileSync(
    join(SAIVAGE_DIR, 'saivage.json'),
    JSON.stringify({
      server: { port: 0, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
      },
    }),
  );

  authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
  process.env['SAIVAGE_API_TOKEN'] = authToken;

  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);

  // Import and register auth plugin
  const { default: authPlugin } = await import('../src/server/auth.js');
  await app.register(authPlugin);

  // Import and register routes
  const { registerCardRoutes } = await import('../src/server/routes/cards.js');
  const { registerRuntimeConfigNotesRoutes } = await import('../src/server/routes/runtime-config-notes.js');
  const { registerChatsFilesDebugRoutes } = await import('../src/server/routes/chats-files-debug.js');
  const { registerWebSocket } = await import('../src/server/websocket.js');

  registerCardRoutes(app, TEST_ROOT);
  registerRuntimeConfigNotesRoutes(app, TEST_ROOT);
  registerChatsFilesDebugRoutes(app, TEST_ROOT);
  registerWebSocket(app, TEST_ROOT);

  // Health — uses the real registerHealth pattern: reads runtime state from disk
  const { readRuntimeState } = await import('../src/utils/runtime-state.js');
  app.get('/health', async (_req, reply) => {
    let runtimeStatus = 'unknown';
    try {
      const state = readRuntimeState(TEST_ROOT);
      if (state) {
        runtimeStatus = state.status;
      }
    } catch {
      // leave as 'unknown'
    }
    return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: runtimeStatus });
  });

  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
  await app.close();
  try { rmSync(TEST_ROOT, { recursive: true, force: true }); } catch { /* noop */ }
}, 10000);

// ── Test Helper ──────────────────────────────────────────────

function url(path: string): string {
  return `http://127.0.0.1:${port}${path}`;
}

// ══════════════════════════════════════════════════════════════
// Health Endpoint Tests
// ══════════════════════════════════════════════════════════════

describe('/health endpoint', () => {
  it('returns status without auth', async () => {
    const res = await fetch(url('/health'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.version).toBe('0.1.0');
    const validRuntimeStatuses = ['idle', 'running', 'paused', 'error', 'unknown'];
    expect(validRuntimeStatuses).toContain(body.runtime);
  });

  it('returns runtime value from actual state file', async () => {
    // The test setup writes 'idle' to .saivage/runtime/state.json
    const res = await fetch(url('/health'));
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    // With the state file present and containing status: 'idle', we should get 'idle'
    expect(body.runtime).toBe('idle');
  });

  it('returns status with auth header (still works)', async () => {
    const res = await fetch(url('/health'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════
// Auth Rejection Tests
// ══════════════════════════════════════════════════════════════

describe('Auth rejection', () => {
  const endpoints = [
    '/api/cards',
    '/api/cards/project',
    '/api/state',
    '/api/agents/some-id/conversation',
    '/api/config',
    '/api/providers',
    '/api/notes',
    '/api/chats',
    '/api/files?path=.',
    '/api/files/content?path=package.json',
    '/api/debug/state',
    '/api/debug/errors',
    '/api/debug/timeline', '/api/debug/doctor', '/api/debug/supervision',
  ];

  for (const ep of endpoints) {
    it(`rejects unauthenticated GET ${ep} with 401`, async () => {
      const res = await fetch(url(ep));
      expect(res.status).toBe(401);
    });
  }

  it('rejects POST /api/cards without auth', async () => {
    const res = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'test' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects PATCH without auth', async () => {
    const res = await fetch(url('/api/cards/project'), {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'new' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects DELETE without auth', async () => {
    const res = await fetch(url('/api/cards/project'), { method: 'DELETE' });
    expect(res.status).toBe(401);
  });

  it('accepts requests with valid Bearer token', async () => {
    const res = await fetch(url('/api/state'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
  });

  it('accepts requests with valid ?token= query param', async () => {
    const res = await fetch(url(`/api/state?token=${authToken}`));
    expect(res.status).toBe(200);
  });

  it('rejects requests with invalid token', async () => {
    const res = await fetch(url('/api/state'), { headers: authHeader('wrong-token') });
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════
// Card CRUD Tests
// ══════════════════════════════════════════════════════════════

describe('Cards API', () => {
  let createdCardId: string;

  it('GET /api/cards lists cards', async () => {
    const res = await fetch(url('/api/cards'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.cards).toBeDefined();
    expect(Array.isArray(body.cards)).toBe(true);
    expect((body.cards as unknown[]).length).toBeGreaterThan(0);
  });

  it('GET /api/cards?status=backlog filters by status', async () => {
    const res = await fetch(url('/api/cards?status=backlog'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const cards = body.cards as Array<{ status: string }>;
    for (const card of cards) {
      expect(card.status).toBe('backlog');
    }
  });

  it('GET /api/cards?type=project filters by type', async () => {
    const res = await fetch(url('/api/cards?type=project'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const cards = body.cards as Array<{ type: string }>;
    expect(cards.length).toBe(1);
    expect(cards[0].type).toBe('project');
  });

  it('GET /api/cards/:id returns card details', async () => {
    const res = await fetch(url('/api/cards/project'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.card).toBeDefined();
  });

  it('GET /api/cards/:id returns 404 for unknown card', async () => {
    const res = await fetch(url('/api/cards/nonexistent'), { headers: authHeader(authToken) });
    expect(res.status).toBe(404);
  });

  it('POST /api/cards creates a card', async () => {
    const res = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'code',
        title: 'Test Card',
        description: 'A test card',
        parent: 'project',
        tags: ['test', 'api'],
        priority: 1,
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    const card = body.card as { id: string; title: string; type: string };
    expect(card.title).toBe('Test Card');
    expect(card.type).toBe('code');
    createdCardId = card.id;
  });

  it('POST /api/cards rejects invalid type', async () => {
    const res = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'plan', title: 'Bad Plan' }),
    });
    expect(res.status).toBe(400);
  });

  it('POST /api/cards rejects terminal child under terminal parent', async () => {
    const createRes = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'code', title: 'Terminal', parent: 'project' }),
    });
    const { card: terminalCard } = await createRes.json() as { card: { id: string } };

    const childRes = await fetch(url('/api/cards'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'code', title: 'Child', parent: terminalCard.id }),
    });
    expect(childRes.status).toBe(400);
  });

  it('PATCH /api/cards/:id updates a card', async () => {
    const res = await fetch(url(`/api/cards/${createdCardId}`), {
      method: 'PATCH',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Updated Title', priority: 5 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const card = body.card as { title: string; priority: number };
    expect(card.title).toBe('Updated Title');
    expect(card.priority).toBe(5);
  });

  it('PATCH /api/cards/:id returns 404 for unknown', async () => {
    const res = await fetch(url('/api/cards/nonexistent'), {
      method: 'PATCH',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Nope' }),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/cards/:id deletes a card', async () => {
    const res = await fetch(url(`/api/cards/${createdCardId}`), {
      method: 'DELETE',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(204);
  });

  it('DELETE /api/cards/:id returns 404 after deletion', async () => {
    const res = await fetch(url(`/api/cards/${createdCardId}`), {
      method: 'DELETE',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(404);
  });

  it('cannot delete project card', async () => {
    const res = await fetch(url('/api/cards/project'), {
      method: 'DELETE',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// Runtime Endpoints
// ══════════════════════════════════════════════════════════════

describe('Runtime API', () => {
  it('GET /api/state returns runtime state', async () => {
    const res = await fetch(url('/api/state'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.runtime).toBeDefined();
    expect(body.cardIndex).toBeDefined();
    const cardIndex = body.cardIndex as { total: number; byStatus: Record<string, number>; byType: Record<string, number> };
    expect(cardIndex.total).toBeGreaterThan(0);
  });

  it('POST /api/runtime/pause pauses runtime', async () => {
    const res = await fetch(url('/api/runtime/pause'), {
      method: 'POST',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('paused');
  });

  it('POST /api/runtime/resume resumes runtime', async () => {
    const res = await fetch(url('/api/runtime/resume'), {
      method: 'POST',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('resumed');
  });
});

// ══════════════════════════════════════════════════════════════
// Config Endpoints
// ══════════════════════════════════════════════════════════════

describe('Config API', () => {
  it('GET /api/config returns config with redacted secrets', async () => {
    const res = await fetch(url('/api/config'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.config).toBeDefined();
    const config = body.config as Record<string, unknown>;
    const providers = config.providers as Record<string, { apiKey?: string }> | undefined;
    if (providers && providers['test']) {
      expect(providers['test'].apiKey).toBe('[REDACTED]');
    }
  });

  it('GET /api/providers returns providers list', async () => {
    const res = await fetch(url('/api/providers'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.providers).toBeDefined();
    const providers = body.providers as Record<string, unknown>;
    expect(Object.keys(providers).length).toBeGreaterThanOrEqual(0);
  });
});

// ══════════════════════════════════════════════════════════════
// Agents / Conversation Endpoint
// ══════════════════════════════════════════════════════════════

describe('Agents API', () => {
  beforeAll(() => {
    writeFileSync(
      join(SAIVAGE_DIR, 'agents', 'sessions', 'test-agent-1.json'),
      JSON.stringify({ id: 'test-agent-1', role: 'planner', status: 'done', started_at: new Date().toISOString() }),
    );
    writeFileSync(
      join(SAIVAGE_DIR, 'agents', 'messages', 'test-agent-1.jsonl'),
      JSON.stringify({ id: 'msg-1', session_id: 'test-agent-1', role: 'user', kind: 'text', content: 'Plan something', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ id: 'msg-2', session_id: 'test-agent-1', role: 'assistant', kind: 'text', content: 'Done', timestamp: new Date().toISOString() }) + '\n',
    );
  });

  it('GET /api/agents/:id/conversation returns session and messages', async () => {
    const res = await fetch(url('/api/agents/test-agent-1/conversation'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.session).toBeDefined();
    expect(body.messages).toBeDefined();
    expect(Array.isArray(body.messages)).toBe(true);
    expect((body.messages as unknown[]).length).toBe(2);
  });

  it('GET /api/agents/:id/conversation returns 404 for unknown session', async () => {
    const res = await fetch(url('/api/agents/unknown-agent/conversation'), { headers: authHeader(authToken) });
    expect(res.status).toBe(404);
  });
});

// ══════════════════════════════════════════════════════════════
// Notes Endpoints
// ══════════════════════════════════════════════════════════════

describe('Notes API', () => {
  beforeAll(() => {
    const cardId = 'project';
    const noteLine = JSON.stringify({
      id: 'n-project-1',
      card_id: cardId,
      author: 'user',
      timestamp: new Date().toISOString(),
      content: 'Test note',
      kind: 'comment',
      handled: false,
    });
    writeFileSync(join(SAIVAGE_DIR, 'notes', 'by-card', `${cardId}.jsonl`), noteLine + '\n');
    writeFileSync(
      join(SAIVAGE_DIR, 'notes', 'queue.json'),
      JSON.stringify({
        entries: [{ card_id: cardId, note_id: 'n-project-1', timestamp: new Date().toISOString(), kind: 'comment' }],
      }),
    );
  });

  it('GET /api/notes lists unhandled notes', async () => {
    const res = await fetch(url('/api/notes'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.notes).toBeDefined();
    expect(Array.isArray(body.notes)).toBe(true);
    expect((body.notes as unknown[]).length).toBe(1);
  });

  it('POST /api/notes/:id/acknowledge marks note as handled', async () => {
    const res = await fetch(url('/api/notes/n-project-1/acknowledge'), {
      method: 'POST',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const note = body.note as { handled: boolean };
    expect(note.handled).toBe(true);
  });

  it('POST /api/notes/:id/acknowledge returns 404 for unknown note', async () => {
    const res = await fetch(url('/api/notes/n-nonexistent/acknowledge'), {
      method: 'POST',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(404);
  });

  it('DELETE /api/notes clears unhandled notes', async () => {
    const res = await fetch(url('/api/notes'), {
      method: 'DELETE',
      headers: authHeader(authToken),
    });
    expect(res.status).toBe(200);
  });
});

// ══════════════════════════════════════════════════════════════
// Chat Endpoints
// ══════════════════════════════════════════════════════════════

describe('Chats API', () => {
  it('GET /api/chats lists chat sessions', async () => {
    const res = await fetch(url('/api/chats'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessions).toBeDefined();
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('GET /api/chats/:sessionId returns messages', async () => {
    writeFileSync(
      join(SAIVAGE_DIR, 'agents', 'sessions', 'analyst-1.json'),
      JSON.stringify({ id: 'analyst-1', role: 'analyst', status: 'active', started_at: new Date().toISOString() }),
    );
    writeFileSync(
      join(SAIVAGE_DIR, 'agents', 'messages', 'analyst-1.jsonl'),
      JSON.stringify({ id: 'msg-1', session_id: 'analyst-1', role: 'user', kind: 'text', content: 'Hello', timestamp: new Date().toISOString() }) + '\n',
    );

    const res = await fetch(url('/api/chats/analyst-1'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessionId).toBe('analyst-1');
    expect(body.messages).toBeDefined();
  });

  it('POST /api/chats/:sessionId sends a message', async () => {
    const res = await fetch(url('/api/chats/analyst-1'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'What is the status?' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.sessionId).toBe('analyst-1');
    expect(body.message).toBeDefined();
    const msg = body.message as { role: string; content: string; timestamp: string };
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBeDefined();
    expect(msg.timestamp).toBeDefined();
    expect(body.toolInvocations).toBeDefined();
    expect(Array.isArray(body.toolInvocations)).toBe(true);
  });

  it('POST /api/chats/:sessionId rejects empty content', async () => {
    const res = await fetch(url('/api/chats/analyst-1'), {
      method: 'POST',
      headers: { ...authHeader(authToken), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});

// ══════════════════════════════════════════════════════════════
// Files Endpoints
// ══════════════════════════════════════════════════════════════

describe('Files API', () => {
  beforeAll(() => {
    writeFileSync(join(TEST_ROOT, 'test-file.txt'), 'Hello World!');
    mkdirSync(join(TEST_ROOT, 'test-dir'), { recursive: true });
    writeFileSync(join(TEST_ROOT, 'test-dir', 'nested.txt'), 'nested');
    writeFileSync(join(TEST_ROOT, 'large-file.bin'), Buffer.alloc(2_000_000, 'x').toString());
  });

  it('GET /api/files lists directory contents', async () => {
    const res = await fetch(url('/api/files?path=.'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.files).toBeDefined();
    const files = body.files as Array<{ name: string }>;
    expect(files.some((f: { name: string }) => f.name === 'test-file.txt')).toBe(true);
  });

  it('GET /api/files rejects path traversal with 403', async () => {
    const res = await fetch(url('/api/files?path=../etc'), { headers: authHeader(authToken) });
    expect(res.status).toBe(403);
  });

  it('GET /api/files/content returns file content', async () => {
    const res = await fetch(url('/api/files/content?path=test-file.txt'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.content).toBe('Hello World!');
  });

  it('GET /api/files/content rejects path traversal with 403', async () => {
    const res = await fetch(url('/api/files/content?path=../etc/passwd'), { headers: authHeader(authToken) });
    expect(res.status).toBe(403);
  });

  it('GET /api/files/content blocks sensitive files with 403', async () => {
    mkdirSync(join(SAIVAGE_DIR), { recursive: true });
    writeFileSync(join(SAIVAGE_DIR, 'auth-profiles.json'), '{"secret": true}');

    const res = await fetch(url('/api/files/content?path=.saivage/auth-profiles.json'), { headers: authHeader(authToken) });
    expect(res.status).toBe(403);
  });

  it('GET /api/files/content returns 413 for files over 1MB', async () => {
    const res = await fetch(url('/api/files/content?path=large-file.bin'), { headers: authHeader(authToken) });
    expect(res.status).toBe(413);
  });

  it('GET /api/files/content returns 404 for non-existent files', async () => {
    const res = await fetch(url('/api/files/content?path=nonexistent.txt'), { headers: authHeader(authToken) });
    expect(res.status).toBe(404);
  });

  it('GET /api/files/content redacts secrets in saivage.json', async () => {
    const res = await fetch(url('/api/files/content?path=.saivage/saivage.json'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.content).toBeDefined();
    const content = body.content as string;
    expect(content).not.toContain('secret-key');
    expect(content).toContain('[REDACTED]');
    expect(content).toContain('test-model');
  });

  it('GET /api/files/content returns plain content for non-sensitive files', async () => {
    const res = await fetch(url('/api/files/content?path=test-file.txt'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.content).toBe('Hello World!');
  });
});

// ══════════════════════════════════════════════════════════════
// Debug Endpoints
// ══════════════════════════════════════════════════════════════

describe('Debug API', () => {
  beforeAll(() => {
    writeFileSync(join(SAIVAGE_DIR, 'runtime', 'errors.jsonl'), JSON.stringify({ error: 'test', timestamp: new Date().toISOString() }) + '\n');
    writeFileSync(join(SAIVAGE_DIR, 'runtime', 'events.jsonl'), JSON.stringify({ event: 'test', timestamp: new Date().toISOString() }) + '\n');
  });

  it('GET /api/debug/state returns runtime dump', async () => {
    const res = await fetch(url('/api/debug/state'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.runtime).toBeDefined();
    expect(body.cards).toBeDefined();
    expect(body.totalCards).toBeGreaterThan(0);
  });

  it('GET /api/debug/errors returns recent errors', async () => {
    const res = await fetch(url('/api/debug/errors'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.errors).toBeDefined();
  });

  it('GET /api/debug/timeline returns event timeline', async () => {
    const res = await fetch(url('/api/debug/timeline'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.events).toBeDefined();
  });

  it('GET /api/debug/state does not leak config secrets', async () => {
    const res = await fetch(url('/api/debug/state'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('secret-key');
  });
});

// ══════════════════════════════════════════════════════════════
// Doctor Endpoint Tests
// ══════════════════════════════════════════════════════════════

describe('Doctor API', () => {
  it('GET /api/debug/doctor returns doctor checks', async () => {
    const res = await fetch(url('/api/debug/doctor'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBeDefined();
    expect(['ok', 'issues_found']).toContain(body.status);
    expect(body.checks).toBeDefined();
    expect(Array.isArray(body.checks)).toBe(true);
    expect(body.issues).toBeDefined();
    expect(Array.isArray(body.issues)).toBe(true);
  });

  it('GET /api/debug/doctor returns checks with correct shape', async () => {
    const res = await fetch(url('/api/debug/doctor'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const checks = body.checks as Array<{ name: string; passed: boolean; details?: string }>;
    for (const check of checks) {
      expect(check.name).toBeDefined();
      expect(typeof check.passed).toBe('boolean');
      expect(typeof check.name).toBe('string');
    }
  });

  it('GET /api/debug/doctor requires auth', async () => {
    const res = await fetch(url('/api/debug/doctor'));
    expect(res.status).toBe(401);
  });
});

// ══════════════════════════════════════════════════════════════
// Supervision Endpoint Tests
// ══════════════════════════════════════════════════════════════

describe('Supervision API', () => {
  it('GET /api/debug/supervision returns supervision data structure', async () => {
    const res = await fetch(url('/api/debug/supervision'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.reviews).toBeDefined();
    expect(Array.isArray(body.reviews)).toBe(true);
    expect(body.quarantine).toBeDefined();
    expect(Array.isArray(body.quarantine)).toBe(true);
    expect(body.stats).toBeDefined();
    const stats = body.stats as Record<string, unknown>;
    expect(typeof stats.total).toBe('number');
    expect(typeof stats.blocked).toBe('number');
    expect(typeof stats.passed).toBe('number');
    expect(typeof stats.sanitized).toBe('number');
    expect(stats.byRisk).toBeDefined();
    expect(stats.bySourceKind).toBeDefined();
  });

  it('GET /api/debug/supervision returns empty data when no reviews exist', async () => {
    const res = await fetch(url('/api/debug/supervision'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const stats = body.stats as Record<string, unknown>;
    expect(stats.total).toBe(0);
    expect(stats.blocked).toBe(0);
    expect(stats.passed).toBe(0);
  });

  it('GET /api/debug/supervision requires auth', async () => {
    const res = await fetch(url('/api/debug/supervision'));
    expect(res.status).toBe(401);
  });

  it('GET /api/debug/supervision quarantine entries have safe shape (no stored_path)', async () => {
    const res = await fetch(url('/api/debug/supervision'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    const quarantine = body.quarantine as Array<Record<string, unknown>>;
    for (const entry of quarantine) {
      expect(entry.quarantine_id).toBeDefined();
      expect(entry.review_id).toBeDefined();
      expect(entry.source_ref).toBeDefined();
      expect(entry.risk).toBeDefined();
      expect(entry.created_at).toBeDefined();
      // stored_path must NOT be exposed in the API
      expect(entry.stored_path).toBeUndefined();
    }
  });

  it('GET /api/debug/supervision does not leak raw content', async () => {
    const res = await fetch(url('/api/debug/supervision'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const text = await res.text();
    // Raw content should never appear in the supervision endpoint
    expect(text).not.toContain('raw.bin');
    expect(text).not.toContain('.saivage-work/quarantine');
  });
});

// ══════════════════════════════════════════════════════════════
// WebSocket Tests
// ══════════════════════════════════════════════════════════════
// WebSocket Tests
// ══════════════════════════════════════════════════════════════

describe('WebSocket', () => {
  it('connects with valid auth token via query param', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${authToken}`);
    ws.on('open', () => {
      ws.close();
      done();
    });
    ws.on('error', (err) => {
      done(err);
    });
  }, 10000);

  it('rejects connection with invalid auth', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=wrong-token`);
    let closed = false;
    ws.on('open', () => {});
    ws.on('close', (code) => {
      if (!closed) {
        closed = true;
        expect(code).not.toBe(1000);
        done();
      }
    });
    ws.on('error', () => {
      if (!closed) {
        closed = true;
        done();
      }
    });
  }, 10000);

  it('rejects connection without auth', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    let closed = false;
    ws.on('open', () => {});
    ws.on('close', (code) => {
      if (!closed) {
        closed = true;
        expect(code).not.toBe(1000);
        done();
      }
    });
    ws.on('error', () => {
      if (!closed) {
        closed = true;
        done();
      }
    });
  }, 10000);

  it('receives welcome message on connect', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${authToken}`);
    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
      expect(data.type).toBe('status');
      expect(data.content.event).toBe('connected');
      ws.close();
      done();
    });
    ws.on('error', (err) => {
      done(err);
    });
  }, 10000);

  it('sends and receives message echoes', (done) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${authToken}`);
    let welcomeReceived = false;

    ws.on('message', (raw) => {
      const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };

      if (!welcomeReceived && data.content.event === 'connected') {
        welcomeReceived = true;
        ws.send(JSON.stringify({ type: 'message', content: { text: 'Hello agent!' } }));
        return;
      }

      if (welcomeReceived && data.type === 'message') {
        ws.close();
        done();
      }
    });

    ws.on('error', (err) => {
      done(err);
    });
  }, 10000);
});

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const TEST_ROOT = join(tmpdir(), `saivage-cards-history-${Date.now()}`);
let app: FastifyInstance;
let port: number;
const authToken = 'test-token';

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
  const now = new Date().toISOString();
  writeFileSync(join(saivageDir, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: 'token="secret-value"', artifacts: [], attachments: [], retries: 0, version_seq: 1 }));
  writeFileSync(join(saivageDir, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(saivageDir, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(saivageDir, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
}

beforeAll(async () => {
  process.env['SAIVAGE_API_TOKEN'] = authToken;
  initializeProjectRoot(TEST_ROOT);
  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const { default: authPlugin } = await import('../../src/server/auth.js');
  await app.register(authPlugin);
  const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
  registerCardRoutes(app, TEST_ROOT);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;

  await fetch(url('/api/cards'), {
    method: 'POST',
    headers: { ...authHeader(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Tracked card', type: 'code', parent: 'project', acceptance: 'accept initial' }),
  });
  await fetch(url('/api/cards/code-1'), {
    method: 'PATCH',
    headers: { ...authHeader(authToken), 'content-type': 'application/json' },
    body: JSON.stringify({ description: 'apiKey="secret-123"', acceptance: 'updated acceptance' }),
  });
}, 30000);

afterAll(async () => {
  await app.close();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('cards history api', () => {
  it('requires auth', async () => {
    const res = await fetch(url('/api/cards/code-1/history'));
    expect(res.status).toBe(401);
  });

  it('lists history headers without snapshot bodies', async () => {
    const res = await fetch(url('/api/cards/code-1/history'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { history: Array<Record<string, unknown>>; total: number };
    expect(body.total).toBe(1);
    expect(body.history[0]?.['snapshot']).toBeUndefined();
    expect(body.history[0]?.['changed_fields']).toEqual(expect.arrayContaining(['description', 'acceptance']));
  });

  it('returns full redacted history entry by sequence', async () => {
    const res = await fetch(url('/api/cards/code-1/history/1'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { entry: { snapshot: { acceptance: string; description: string } } };
    expect(body.entry.snapshot.acceptance).toBe('accept initial');
    expect(body.entry.snapshot.description).not.toContain('secret-123');
  });

  it('returns diff with redacted values', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?from=1&to=2'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { diff: Array<{ field: string; before: unknown; after: unknown }> };
    const description = body.diff.find((entry) => entry.field === 'description');
    expect(description).toBeDefined();
    expect(JSON.stringify(description)).not.toContain('secret-123');
  });

  it('resolves to=last as the current version_seq with non-empty diff', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?from=1&to=last'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { from: number; to: number; diff: unknown[]; card_id: string };
    expect(body.from).toBe(1);
    expect(body.to).toBeGreaterThanOrEqual(2);
    expect(body.card_id).toBe('code-1');
    expect(Array.isArray(body.diff)).toBe(true);
    expect(body.diff.length).toBeGreaterThan(0);
  });

  it('defaults from to max(1, to-1) when only to=last is supplied', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?to=last'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { from: number; to: number };
    expect(body.to).toBeGreaterThanOrEqual(1);
    expect(body.from).toBe(Math.max(1, body.to - 1));
  });

  it('applies defaults when no pivots are supplied', async () => {
    const res = await fetch(url('/api/cards/code-1/diff'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { from: number; to: number };
    expect(body.to).toBeGreaterThanOrEqual(1);
    expect(body.from).toBe(Math.max(1, body.to - 1));
    expect(body.from).toBeGreaterThanOrEqual(1);
  });

  it('rejects from=last&to=1 with 400 after post-resolution from > to', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?from=last&to=1'), { headers: authHeader(authToken) });
    expect(res.status).toBe(400);
  });

  it('accepts current as an alias for last', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?from=1&to=current'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { from: number; to: number };
    expect(body.from).toBe(1);
    expect(body.to).toBeGreaterThanOrEqual(2);
  });

  it('rejects from=0 because the regex excludes zero', async () => {
    const res = await fetch(url('/api/cards/code-1/diff?from=0&to=last'), { headers: authHeader(authToken) });
    expect(res.status).toBe(400);
  });

  it('returns not found and validation errors', async () => {
    const missingCard = await fetch(url('/api/cards/missing/history'), { headers: authHeader(authToken) });
    expect(missingCard.status).toBe(404);

    const missingSeq = await fetch(url('/api/cards/code-1/history/999'), { headers: authHeader(authToken) });
    expect(missingSeq.status).toBe(404);

    const badDiff = await fetch(url('/api/cards/code-1/diff?from=a&to=2'), { headers: authHeader(authToken) });
    expect(badDiff.status).toBe(400);
  });
});

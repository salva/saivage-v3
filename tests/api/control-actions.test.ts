import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordControlAction } from '../../src/persistence/control-action-audit.js';

const TEST_ROOT = join(tmpdir(), `saivage-control-actions-${Date.now()}`);
let app: FastifyInstance;
let port: number;
const authToken = 'test-token';

function authHeader(token?: string): Record<string, string> {
  if (!token) return {};
  return { authorization: `Bearer ${token}` };
}
function url(path: string): string { return `http://127.0.0.1:${port}${path}`; }
function initializeProjectRoot(root: string): void {
  const saivageDir = join(root, '.saivage');
  mkdirSync(join(saivageDir, 'cards', 'by-id'), { recursive: true });
  mkdirSync(join(saivageDir, 'cards', 'tree'), { recursive: true });
  mkdirSync(join(saivageDir, 'cards', 'dependencies'), { recursive: true });
  mkdirSync(join(saivageDir, 'notes', 'by-card'), { recursive: true });
  mkdirSync(join(saivageDir, 'runtime'), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(saivageDir, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0, version_seq: 1 }));
  writeFileSync(join(saivageDir, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(saivageDir, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(saivageDir, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(saivageDir, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }));
}

beforeAll(async () => {
  process.env['SAIVAGE_API_TOKEN'] = authToken;
  initializeProjectRoot(TEST_ROOT);
  recordControlAction(TEST_ROOT, { actor: 'analyst', surface: 'rest', action: 'card.update', target_kind: 'card', target_id: 'project', params_summary: 'apiKey="secret-abc"', confirmed: true, outcome: 'ok', outcome_summary: 'updated' , created_at: '2026-01-01T00:00:00.000Z', id: 'audit-1'});
  recordControlAction(TEST_ROOT, { actor: 'analyst', surface: 'rest', action: 'runtime.pause', target_kind: 'runtime', target_id: 'project', params_summary: 'pause', confirmed: true, outcome: 'ok', outcome_summary: 'paused', created_at: '2026-01-02T00:00:00.000Z', id: 'audit-2' });
  app = Fastify({ logger: false });
  await app.register(cors);
  await app.register(websocket);
  const { default: authPlugin } = await import('../../src/server/auth.js');
  await app.register(authPlugin);
  const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
  registerRuntimeConfigNotesRoutes(app, TEST_ROOT);
  await app.listen({ port: 0, host: '127.0.0.1' });
  port = (app.server.address() as { port: number }).port;
}, 30000);

afterAll(async () => {
  await app.close();
  rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('control actions api', () => {
  it('requires auth', async () => {
    const res = await fetch(url('/api/control-actions'));
    expect(res.status).toBe(401);
  });

  it('lists redacted control actions', async () => {
    const res = await fetch(url('/api/control-actions'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { control_actions: Array<{ id: string; params_summary: string }> };
    expect(body.control_actions).toHaveLength(2);
    expect(body.control_actions.find((entry) => entry.id === 'audit-1')?.params_summary).not.toContain('secret-abc');
  });

  it('filters by card id and since', async () => {
    const byCard = await fetch(url('/api/control-actions?card_id=project'), { headers: authHeader(authToken) });
    expect(byCard.status).toBe(200);
    const byCardBody = await byCard.json() as { control_actions: Array<{ id: string }> };
    expect(byCardBody.control_actions.some((entry) => entry.id === 'audit-1')).toBe(true);

    const since = await fetch(url('/api/control-actions?since=2026-01-02T00:00:00.000Z'), { headers: authHeader(authToken) });
    expect(since.status).toBe(200);
    const sinceBody = await since.json() as { control_actions: Array<{ id: string }> };
    expect(sinceBody.control_actions.map((entry) => entry.id)).toEqual(['audit-2']);
  });
});

import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotificationCenter } from '../../src/utils/notification-center.js';

const TEST_ROOT = join(tmpdir(), `saivage-notifications-${Date.now()}`);
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
  const center = new NotificationCenter(TEST_ROOT);
  center.enqueueForOperator({ id: 'notif-1', kind: 'config_changed', severity: 'warn', payload_summary: 'apiKey="secret-xyz" changed', source_actor: 'analyst', source_surface: 'rest' });
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

describe('notifications api', () => {
  it('requires auth', async () => {
    const res = await fetch(url('/api/notifications'));
    expect(res.status).toBe(401);
  });

  it('lists redacted operator notifications', async () => {
    const res = await fetch(url('/api/notifications'), { headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { notifications: Array<{ id: string; payload_summary: string }> };
    expect(body.notifications).toHaveLength(1);
    expect(body.notifications[0]?.id).toBe('notif-1');
    expect(body.notifications[0]?.payload_summary).not.toContain('secret-xyz');
  });

  it('acknowledges notifications and returns not found for missing ids', async () => {
    const res = await fetch(url('/api/notifications/notif-1/acknowledge'), { method: 'POST', headers: authHeader(authToken) });
    expect(res.status).toBe(200);
    const body = await res.json() as { notification: { acknowledged_at: string | null } };
    expect(body.notification.acknowledged_at).not.toBeNull();

    const missing = await fetch(url('/api/notifications/missing/acknowledge'), { method: 'POST', headers: authHeader(authToken) });
    expect(missing.status).toBe(404);
  });
});

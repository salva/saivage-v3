import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  cpSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { ServerInstance } from '../../src/server/server.js';
import { isLocked, releaseLock } from '../../src/utils/runtime-lock.js';
import { CardStore } from '../../src/utils/card-store.js';
import { getRuntimeEventSubscriptionCount } from '../../src/server/websocket.js';

const AUTH_TOKEN = 'ar-server-test-token-' + Math.random().toString(36).slice(2, 8);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

function setupProjectDir(root: string): void {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages','diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { port: 8080, host: '127.0.0.1' }, models: { default: ['test-model'] }, providers: { test: { priority: 10, models: ['test-model'], apiKey: 'ar-server-test-api-key' } }, runtime: { autoDispatchBacklog: false }, supervisor: { enabled: false } }, null, 2));
  writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, current_card_id: null, current_agent_session_id: null, paused: false, paused_at: null, queue: [], running_processes: [], updated_at: now }, null, 2));
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }, null, 2));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }, null, 2));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(sd, 'runtime', 'events.jsonl'), '');
  writeFileSync(join(sd, 'runtime', 'errors.jsonl'), '');
  const realWebDist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(realWebDist)) {
    const tmpWebDist = join(root, 'web', 'dist');
    mkdirSync(dirname(tmpWebDist), { recursive: true });
    cpSync(realWebDist, tmpWebDist, { recursive: true });
  }
}


interface InjectFetchResponse {
  status: number;
  json: <T = unknown>() => T;
  arrayBuffer: () => Promise<ArrayBuffer>;
}

function toFetchLikeResponse(res: LightMyRequestResponse): InjectFetchResponse {
  return {
    status: res.statusCode,
    json: <T = unknown>() => res.json() as T,
    arrayBuffer: async () => Buffer.from(res.payload).buffer,
  };
}

async function drainResponse(res: InjectFetchResponse): Promise<void> {
  try {
    await res.arrayBuffer();
  } catch {
  }
}

function addGoalCard(projectRoot: string, goalId: string, title: string): void {
  const store = new CardStore(projectRoot);
  store.create({ id: goalId, type: 'goal', parent: 'project', depth: 0, title, description: `Goal: ${title}`, status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: `Test acceptance for ${title}`, artifacts: [], attachments: [], retries: 0 });
}

describe('Server with ActiveRuntime (createRuntime=true)', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-server-'));
    setupProjectDir(tmpDir);
    addGoalCard(tmpDir, 'goal-test-1', 'Test Server Goal');
    process.chdir(tmpDir);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir, true);
  }, 30000);

  afterAll(async () => {
    try { process.chdir(originalCwd); } catch {}
    if (server) try { await server.stop(); } catch {}
    try { releaseLock(tmpDir); } catch {}
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }, 15000);

  async function fetchServer(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<InjectFetchResponse> {
    const response = await server.fastify.inject({
      method: (init.method ?? 'GET') as InjectOptions['method'],
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return toFetchLikeResponse(response);
  }
  function authHeaders(): Record<string, string> { return { authorization: `Bearer ${AUTH_TOKEN}` }; }

  describe('ActiveRuntime instance availability', () => {
    it('server instance has activeRuntime defined when createRuntime=true', () => { expect(server.activeRuntime).toBeDefined(); });
    it('activeRuntime.getStatus() returns expected values', () => { const status = server.activeRuntime!.getStatus(); expect(typeof status.status).toBe('string'); expect(typeof status.paused).toBe('boolean'); expect(typeof status.goalCount).toBe('number'); });
    it('activeRuntime reports goalCount from the card store', () => { expect(server.activeRuntime!.getStatus().goalCount).toBeGreaterThanOrEqual(1); });
  });

  describe('Server stop releases ActiveRuntime lock', () => {
    it('lock is held while server is running with createRuntime=true', () => { expect(isLocked(tmpDir)).toBe(true); });
    it('activeRuntime is in a valid state while server is running', () => { const status = server.activeRuntime!.getStatus(); expect(status.status).toBe('idle'); expect(status.paused).toBe(false); });
    it('registers exactly one runtime event subscription while running', () => { expect(getRuntimeEventSubscriptionCount()).toBe(1); });
  });

  describe('GET /api/runtime/status', () => {
    it('returns 200 with status info', async () => { const res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); expect(res.status).toBe(200); const body = await res.json() as Record<string, unknown>; expect(body).toHaveProperty('runtime'); expect(body).toHaveProperty('paused'); expect(body).toHaveProperty('currentCardId'); expect(body).toHaveProperty('goalCount'); });
    it('requires auth (returns 401 without token)', async () => { const res = await fetchServer('/api/runtime/status'); expect(res.status).toBe(401); });
    it('returns sensible runtime status value', async () => { const res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); const body = await res.json() as Record<string, unknown>; expect(['idle', 'running', 'paused', 'error', 'frozen']).toContain(body.runtime); });
    it('paused is false initially', async () => { const res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); const body = await res.json() as Record<string, unknown>; expect(body.paused).toBe(false); });
  });


  describe('Explicit start_project / stop_project API', () => {
    it('POST /api/runtime/start_project returns command, intent, and root run records', async () => {
      const res = await fetchServer('/api/runtime/start_project', { method: 'POST', headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(body).toMatchObject({ success: true, command: { command: 'start_project', status: 'completed' }, intent: { status: 'running' }, run: { kind: 'root', card_id: 'project' } });
    }, 15000);

    it('POST /api/runtime/start_project while already running returns actionable precondition error', async () => {
      const res = await fetchServer('/api/runtime/start_project', { method: 'POST', headers: authHeaders() });
      expect(res.status).toBe(409);
      const body = await res.json() as Record<string, any>;
      expect(body.success).toBe(false);
      expect(body.actionable_error).toMatchObject({ code: 'runtime_start_precondition_failed' });
      expect(body.command).toMatchObject({ command: 'start_project', status: 'rejected' });
    });

    it('POST /api/runtime/stop_project returns command and stopped intent records', async () => {
      const res = await fetchServer('/api/runtime/stop_project', { method: 'POST', headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, any>;
      expect(body).toMatchObject({ success: true, command: { command: 'stop_project', status: 'completed' }, intent: { status: 'stopped' } });
    });

    it('does not expose old /api/runtime/lets_dance route alias', async () => {
      const res = await fetchServer('/api/runtime/lets_dance', { method: 'POST', headers: authHeaders() });
      expect(res.status).toBe(404);
    });
  });


  describe('Pause / Resume via API', () => {
    it('POST /api/runtime/pause sets paused to true', async () => { const res = await fetchServer('/api/runtime/pause', { method: 'POST', headers: authHeaders() }); expect(res.status).toBe(200); const body = await res.json() as Record<string, unknown>; expect(body).toMatchObject({ project_id: 'project', paused: true, queue: expect.any(Array), running_processes: expect.any(Array) }); expect(server.activeRuntime!.getStatus().paused).toBe(true); });
    it('POST /api/runtime/resume sets paused to false', async () => { await drainResponse(await fetchServer('/api/runtime/pause', { method: 'POST', headers: authHeaders() })); const res = await fetchServer('/api/runtime/resume', { method: 'POST', headers: authHeaders() }); expect(res.status).toBe(200); const body = await res.json() as Record<string, unknown>; expect(body).toMatchObject({ project_id: 'project', paused: false, paused_at: null, queue: expect.any(Array), running_processes: expect.any(Array) }); expect(server.activeRuntime!.getStatus().paused).toBe(false); });
    it('GET /api/runtime/status reflects pause/resume changes', async () => { await drainResponse(await fetchServer('/api/runtime/pause', { method: 'POST', headers: authHeaders() })); let res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); let body = await res.json() as Record<string, unknown>; expect(body.paused).toBe(true); await drainResponse(await fetchServer('/api/runtime/resume', { method: 'POST', headers: authHeaders() })); res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); body = await res.json() as Record<string, unknown>; expect(body.paused).toBe(false); });
    it('analyst chat pause/resume controls ActiveRuntime in-memory state', async () => { const pauseRes = await fetchServer('/api/chats/runtime-control-live', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ content: 'pause runtime' }) }); expect(pauseRes.status).toBe(200); const pauseBody = await pauseRes.json() as { toolInvocations?: Array<{ tool: string }> }; expect(pauseBody.toolInvocations?.some((inv) => inv.tool === 'pause_runtime')).toBe(true); expect(server.activeRuntime!.getStatus().paused).toBe(true); const resumeRes = await fetchServer('/api/chats/runtime-control-live', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ content: 'resume runtime' }) }); expect(resumeRes.status).toBe(200); const resumeBody = await resumeRes.json() as { toolInvocations?: Array<{ tool: string }> }; expect(resumeBody.toolInvocations?.some((inv) => inv.tool === 'resume_runtime')).toBe(true); expect(server.activeRuntime!.getStatus().paused).toBe(false); });
  });

  describe('Freeze / Resume via API', () => {
    it('POST /api/runtime/freeze creates a freeze manifest', async () => { const res = await fetchServer('/api/runtime/freeze', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'API freeze test' }) }); expect(res.status).toBe(200); const body = await res.json<Record<string, unknown>>(); expect(body.status).toBe('frozen'); expect(body.freeze_id).toBeDefined(); expect(body.reason).toBe('API freeze test'); expect(body.created_at).toBeDefined(); });
    it('POST /api/runtime/freeze when already frozen keeps returning frozen state', async () => { const res = await fetchServer('/api/runtime/freeze', { method: 'POST', headers: { ...authHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'second freeze' }) }); expect(res.status).toBe(200); const body = await res.json<Record<string, unknown>>(); expect(body.status).toBe('frozen'); });
    it('POST /api/runtime/resume-from-freeze restores state', async () => { const res = await fetchServer('/api/runtime/resume-from-freeze', { method: 'POST', headers: authHeaders() }); expect(res.status).toBe(200); const body = await res.json<Record<string, unknown>>(); expect(body.status).toBe('resumed'); expect(body.freeze_id).toBeDefined(); expect(body.restored_queue).toBeDefined(); expect(body.restored_processes).toBeDefined(); });
    it('POST /api/runtime/resume-from-freeze after resume returns error', async () => { const res = await fetchServer('/api/runtime/resume-from-freeze', { method: 'POST', headers: authHeaders() }); expect(res.status).toBe(500); const body = await res.json<Record<string, string>>(); expect(body.error).toContain('Failed to resume from freeze'); });
    it('freeze requires auth', async () => { const res = await fetchServer('/api/runtime/freeze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'unauth freeze' }) }); expect(res.status).toBe(401); await drainResponse(res); });
    it('resume-from-freeze requires auth', async () => { const res = await fetchServer('/api/runtime/resume-from-freeze', { method: 'POST' }); expect(res.status).toBe(401); await drainResponse(res); });
  });
});

describe('Server without ActiveRuntime (createRuntime=false)', () => {
  let tmpDir: string; let server: ServerInstance; let originalCwd: string;
  beforeAll(async () => { originalCwd = process.cwd(); tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-nort-')); setupProjectDir(tmpDir); process.chdir(tmpDir); process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN; const { createServer } = await import('../../src/server/server.js'); server = await createServer(tmpDir, false); }, 30000);
  afterAll(async () => { try { process.chdir(originalCwd); } catch {} if (server) try { await server.stop(); } catch {} try { releaseLock(tmpDir); } catch {} try { rmSync(tmpDir, { recursive: true, force: true }); } catch {} }, 15000);
  async function fetchServer(path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<InjectFetchResponse> {
    const response = await server.fastify.inject({
      method: (init.method ?? 'GET') as InjectOptions['method'],
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return toFetchLikeResponse(response);
  }
  function authHeaders(): Record<string, string> { return { authorization: `Bearer ${AUTH_TOKEN}` }; }
  describe('Server instance without runtime', () => {
    it('activeRuntime is undefined when createRuntime=false', () => { expect(server.activeRuntime).toBeUndefined(); });
    it('GET /api/runtime/status still works (fallback to state file)', async () => { const res = await fetchServer('/api/runtime/status', { headers: authHeaders() }); expect(res.status).toBe(200); const body = await res.json() as Record<string, unknown>; expect(body).toHaveProperty('runtime'); expect(typeof body.runtime).toBe('string'); });
    it('server still functions normally without ActiveRuntime', () => { expect(server.fastify).toBeDefined(); expect(server.config).toBeDefined(); expect(typeof server.stop).toBe('function'); });

    it('POST /api/runtime/start_project returns actionable precondition error without ActiveRuntime', async () => {
      const res = await fetchServer('/api/runtime/start_project', { method: 'POST', headers: authHeaders() });
      expect(res.status).toBe(503);
      const body = await res.json() as Record<string, any>;
      expect(body.success).toBe(false);
      expect(body.actionable_error).toMatchObject({ code: 'active_runtime_unavailable', cardId: 'project' });
    });

  });
});

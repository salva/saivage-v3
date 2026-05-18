import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startProcess, waitProcess, saveRegistry } from '../../src/utils/process-runner.js';
import type { ProcessRecord } from '../../src/schemas/types.js';

function uniqueDir(): string {
  return join(tmpdir(), `saivage-process-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
}

function setupProject(projectRoot: string): void {
  const sd = join(projectRoot, '.saivage');
  mkdirSync(sd, { recursive: true });
  for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'runtime', 'agents/sessions', 'agents/messages', 'diaries', 'supervision']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  mkdirSync(join(projectRoot, '.saivage-work', 'processes'), { recursive: true });
  const config = { server: { port: 8080, host: '127.0.0.1' }, models: { default: ['test-model'] }, providers: { test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' } } };
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify(config, null, 2));
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));
  writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({ status: 'idle', project_id: 'project', pid: process.pid, started_at: now, paused: false, queue: [], running_processes: [], updated_at: now }));
}

function transientRecord(projectRoot: string): ProcessRecord {
  const runningAt = new Date(Date.now() - 60000).toISOString();
  return {
    id: 'proc-transient-001',
    card_id: 'card-goal-1',
    command: 'npm test --token sk-live-secret-123 -- --coverage',
    command_hash: 'b'.repeat(64),
    cwd: projectRoot,
    cwd_canonical: projectRoot,
    status: 'running',
    pid: 12345,
    started_at: runningAt,
    started_at_monotonic: 1,
    completed_at: null,
    exit_code: null,
    required_for_card_completion: true,
    output_dir: join(projectRoot, '.saivage-work', 'processes', 'proc-transient-001'),
    stdout_path: join(projectRoot, '.saivage-work', 'processes', 'proc-transient-001', 'stdout.log'),
    stderr_path: join(projectRoot, '.saivage-work', 'processes', 'proc-transient-001', 'stderr.log'),
    combined_log_path: join(projectRoot, '.saivage-work', 'processes', 'proc-transient-001', 'combined.log'),
    agent_session_id: 'session-agent-exec-1',
    goal_id: 'card-goal-1',
    launch_reason: 'Execute test suite for goal card-goal-1',
    owner_kind: 'agent',
    background_policy: 'foreground',
    process_group_id: null,
  };
}

describe('GET /api/processes read-only process views', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;
  let liveProcId: string;
  let endedProcId: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot);
    saveRegistry(projectRoot, [transientRecord(projectRoot)]);

    const live = startProcess(projectRoot, 'sleep 0.4', { cardId: 'card-live', ownerKind: 'agent', agentSessionId: 'session-live' });
    liveProcId = live.id;
    const ended = startProcess(projectRoot, 'echo done', { cardId: 'card-ended' });
    endedProcId = ended.id;
    await waitProcess(projectRoot, ended.id);

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);
    const { registerProcessRoutes } = await import('../../src/server/routes/processes.js');
    registerProcessRoutes(app, projectRoot);
    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch {}
  }, 10000);

  function apiUrl(path: string): string { return `http://127.0.0.1:${port}${path}`; }
  function authHdr(): Record<string, string> { return { authorization: `Bearer ${authToken}` }; }

  it('returns read-only control availability for a running live process', async () => {
    const res = await fetch(apiUrl(`/api/processes/${liveProcId}`), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { process: any };
    expect(body.process.status).toBe('running');
    expect(body.process.control).toEqual(expect.objectContaining({ termination_available: false }));
    expect(body.process.control).not.toHaveProperty('can_terminate');
  });

  it('redacts commands and still does not expose termination controls for transient records', async () => {
    const res = await fetch(apiUrl('/api/processes/proc-transient-001'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { process: any };
    expect(body.process.command).toContain('sk-[REDACTED]');
    expect(body.process.command).not.toContain('sk-live-secret-123');
    expect(body.process.control.termination_available).toBe(false);
    expect(body.process.control.unavailable_reason).toContain('not available');
  });

  it('keeps list endpoint safe and typed', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { processes: Array<Record<string, any>> };
    expect(body.processes.length).toBeGreaterThanOrEqual(3);
    for (const proc of body.processes) {
      expect(proc).not.toHaveProperty('stdout_path');
      expect(proc).not.toHaveProperty('stderr_path');
      expect(proc).not.toHaveProperty('combined_log_path');
      expect(proc).not.toHaveProperty('output_dir');
      expect(proc.control.termination_available).toBe(false);
      expect(proc.control).not.toHaveProperty('can_terminate');
    }
  });

  it('does not register a process termination route', async () => {
    const res = await fetch(apiUrl(`/api/processes/${endedProcId}/terminate`), { method: 'POST', headers: authHdr() });
    expect(res.status).toBe(404);
  });

  it('process endpoints remain auth protected', async () => {
    expect((await fetch(apiUrl('/api/processes'))).status).toBe(401);
    expect((await fetch(apiUrl(`/api/processes/${liveProcId}`))).status).toBe(401);
  });
});

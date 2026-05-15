import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function uniqueDir(): string {
  return join(
    tmpdir(),
    `saivage-process-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
}

function setupProject(projectRoot: string, overrides: Record<string, unknown> = {}): void {
  const sd = join(projectRoot, '.saivage');
  mkdirSync(sd, { recursive: true });
  for (const d of [
    'cards/by-id',
    'cards/tree',
    'cards/dependencies',
    'notes/by-card',
    'runtime',
    'agents/sessions',
    'agents/messages',
    'diaries',
    'supervision',
  ]) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  mkdirSync(join(projectRoot, '.saivage-work', 'processes'), { recursive: true });

  const config = {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: {
      test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
    },
    ...overrides,
  };

  writeFileSync(join(sd, 'saivage.json'), JSON.stringify(config, null, 2));

  const now = new Date().toISOString();
  writeFileSync(
    join(sd, 'cards', 'by-id', 'project.json'),
    JSON.stringify({
      id: 'project', type: 'project', parent: null, depth: 0,
      title: 'project', description: '', status: 'backlog',
      tags: [], priority: 0, urgency: 'normal', created_by: 'analyst',
      created_at: now, updated_at: now,
      depends_on: [], blocks: [], related: [], acceptance: '',
      artifacts: [], attachments: [], retries: 0,
    }),
  );
  writeFileSync(
    join(sd, 'cards', 'index.json'),
    JSON.stringify({
      cards: {
        project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' },
      },
    }),
  );
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));

  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle', project_id: 'project', pid: process.pid,
      started_at: now, paused: false, queue: [],
      running_processes: [], updated_at: now,
    }),
  );
}

function seedProcessRegistry(projectRoot: string): void {
  const rp = join(projectRoot, '.saivage', 'runtime', 'processes.json');
  const now = new Date().toISOString();
  const runningAt = new Date(Date.now() - 60000).toISOString();
  const exitedAt = new Date(Date.now() - 30000).toISOString();

  const records: Record<string, unknown>[] = [
    {
      id: 'proc-full-001',
      card_id: 'card-goal-1',
      command: 'npm test --token sk-live-secret-123 -- --coverage',
      cwd: projectRoot,
      status: 'running',
      pid: 12345,
      started_at: runningAt,
      completed_at: null,
      exit_code: null,
      required_for_card_completion: true,
      output_dir: join(projectRoot, '.saivage-work', 'processes', 'proc-full-001'),
      stdout_path: join(projectRoot, '.saivage-work', 'processes', 'proc-full-001', 'stdout.log'),
      stderr_path: join(projectRoot, '.saivage-work', 'processes', 'proc-full-001', 'stderr.log'),
      combined_log_path: join(projectRoot, '.saivage-work', 'processes', 'proc-full-001', 'combined.log'),
      agent_session_id: 'session-agent-exec-1',
      goal_id: 'card-goal-1',
      launch_reason: 'Execute test suite for goal card-goal-1',
      owner_kind: 'agent',
      background_policy: 'foreground',
      process_group_id: null,
    },
    {
      id: 'proc-min-002',
      card_id: 'card-ops-1',
      command: 'echo "hello"',
      cwd: '/outside/project',
      status: 'exited',
      pid: null,
      started_at: exitedAt,
      completed_at: now,
      exit_code: 0,
      required_for_card_completion: false,
      output_dir: '/outside/project/processes/proc-min-002',
      stdout_path: '/outside/project/processes/proc-min-002/stdout.log',
      stderr_path: '/outside/project/processes/proc-min-002/stderr.log',
      combined_log_path: '/outside/project/processes/proc-min-002/combined.log',
      agent_session_id: null,
      goal_id: null,
      launch_reason: null,
      owner_kind: null,
      background_policy: null,
      process_group_id: null,
    },
  ];

  writeFileSync(rp, JSON.stringify(records, null, 2) + '\n');
}

describe('Stage 57 — GET /api/processes (safe process views)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});
    seedProcessRegistry(projectRoot);

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

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  it('returns safe ProcessView shape for list endpoint', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { processes: Array<Record<string, unknown>> };
    expect(body.processes.length).toBe(2);

    const proc = body.processes[0]!;
    expect(proc).toEqual(expect.objectContaining({
      id: expect.any(String),
      status: expect.any(String),
      started_at: expect.any(String),
      command: expect.any(String),
      card_id: expect.any(String),
      logs: expect.any(Object),
      control: expect.any(Object),
    }));
    expect(proc).not.toHaveProperty('stdout_path');
    expect(proc).not.toHaveProperty('stderr_path');
    expect(proc).not.toHaveProperty('combined_log_path');
    expect(proc).not.toHaveProperty('output_dir');
    expect(proc).not.toHaveProperty('required_for_card_completion');
  });

  it('redacts secret-bearing command strings and exposes contained relative log refs only', async () => {
    const res = await fetch(apiUrl('/api/processes/proc-full-001'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { process: any };
    expect(body.process.command).toContain('sk-[REDACTED]');
    expect(body.process.command).not.toContain('sk-live-secret-123');
    expect(body.process.logs).toEqual({
      stdout: '.saivage-work/processes/proc-full-001/stdout.log',
      stderr: '.saivage-work/processes/proc-full-001/stderr.log',
      combined: '.saivage-work/processes/proc-full-001/combined.log',
    });
  });

  it('does not expose absolute paths outside project containment', async () => {
    const res = await fetch(apiUrl('/api/processes/proc-min-002'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const body = await res.json() as { process: any };
    expect(body.process.cwd).toBeNull();
    expect(body.process.logs).toEqual({ stdout: null, stderr: null, combined: null });
    expect(JSON.stringify(body.process)).not.toContain('/outside/project');
  });

  it('GET /api/processes/:id returns 404 for nonexistent process', async () => {
    const res = await fetch(apiUrl('/api/processes/nonexistent-id'), { headers: authHdr() });
    expect(res.status).toBe(404);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Process not found');
  });

  it('GET /api/processes/ with trailing slash returns 400', async () => {
    const res = await fetch(apiUrl('/api/processes/'), { headers: authHdr() });
    expect(res.status).toBe(400);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Process ID is required.');
  });

  it('process endpoints remain auth protected', async () => {
    expect((await fetch(apiUrl('/api/processes'))).status).toBe(401);
    expect((await fetch(apiUrl('/api/processes/proc-full-001'))).status).toBe(401);
  });
});

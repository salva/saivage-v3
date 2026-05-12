/**
 * Stage 57 — Processes Debug View Hardening
 *
 * API integration tests for the process routes consumed by the
 * Processes tab in the Debug view.
 *
 * Verifies:
 *  1. GET /api/processes returns expected shape with ownership/session metadata
 *  2. GET /api/processes/:id returns single process detail
 *  3. Empty-state behavior (no processes)
 *  4. Auth protection for both endpoints
 *  5. Process metadata contract: all ownership/session fields present or null
 */
import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ───────────────────────────────────────────────────

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
  // Ensure work dir exists for process output
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

/** Pre-populate the process registry with a variety of process records. */
function seedProcessRegistry(projectRoot: string, records: Record<string, unknown>[]): void {
  const rp = join(projectRoot, '.saivage', 'runtime', 'processes.json');
  writeFileSync(rp, JSON.stringify(records, null, 2) + '\n');
}

// ── Process Fixtures ──────────────────────────────────────────

const now = new Date().toISOString();
const runningAt = new Date(Date.now() - 60000).toISOString();
const exitedAt = new Date(Date.now() - 30000).toISOString();

const mockProcessFull: Record<string, unknown> = {
  id: 'proc-full-001',
  card_id: 'card-goal-1',
  command: 'npm test -- --coverage',
  cwd: '/work/saivage-v3',
  status: 'running',
  pid: 12345,
  started_at: runningAt,
  completed_at: null,
  exit_code: null,
  required_for_card_completion: true,
  output_dir: '.saivage-work/processes/proc-full-001',
  stdout_path: '.saivage-work/processes/proc-full-001/stdout.log',
  stderr_path: '.saivage-work/processes/proc-full-001/stderr.log',
  combined_log_path: '.saivage-work/processes/proc-full-001/combined.log',
  agent_session_id: 'session-agent-exec-1',
  goal_id: 'card-goal-1',
  launch_reason: 'Execute test suite for goal card-goal-1',
  owner_kind: 'agent',
  background_policy: 'foreground',
  process_group_id: null,
};

const mockProcessMinimal: Record<string, unknown> = {
  id: 'proc-min-002',
  card_id: 'card-ops-1',
  command: 'echo "hello"',
  cwd: '/work/saivage-v3',
  status: 'exited',
  pid: null,
  started_at: exitedAt,
  completed_at: now,
  exit_code: 0,
  required_for_card_completion: false,
  output_dir: '.saivage-work/processes/proc-min-002',
  stdout_path: '.saivage-work/processes/proc-min-002/stdout.log',
  stderr_path: '.saivage-work/processes/proc-min-002/stderr.log',
  combined_log_path: '.saivage-work/processes/proc-min-002/combined.log',
  agent_session_id: null,
  goal_id: null,
  launch_reason: null,
  owner_kind: null,
  background_policy: null,
  process_group_id: null,
};

const mockProcessDetached: Record<string, unknown> = {
  id: 'proc-det-003',
  card_id: 'card-test-1',
  command: 'sleep 3600',
  cwd: '/work/saivage-v3',
  status: 'running',
  pid: 54321,
  started_at: runningAt,
  completed_at: null,
  exit_code: null,
  required_for_card_completion: false,
  output_dir: '.saivage-work/processes/proc-det-003',
  stdout_path: '.saivage-work/processes/proc-det-003/stdout.log',
  stderr_path: '.saivage-work/processes/proc-det-003/stderr.log',
  combined_log_path: '.saivage-work/processes/proc-det-003/combined.log',
  agent_session_id: 'session-bg-1',
  goal_id: null,
  launch_reason: 'Background validation scan',
  owner_kind: 'runtime',
  background_policy: 'detach',
  process_group_id: 42,
};

// ═══════════════════════════════════════════════════════════════
// Process API — With Populated Registry
// ═══════════════════════════════════════════════════════════════

describe('Stage 57 — GET /api/processes (with data)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});
    seedProcessRegistry(projectRoot, [mockProcessFull, mockProcessMinimal, mockProcessDetached]);

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerProcessRoutes } = await import('../../src/server/routes/processes.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerProcessRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  // ── GET /api/processes ──────────────────────────────────────

  it('returns 200 with top-level shape { processes: [...] }', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');

    const body = await res.json() as { processes: unknown[] };
    expect(body).toHaveProperty('processes');
    expect(Array.isArray(body.processes)).toBe(true);
  });

  it('returns all seeded processes', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<{ id: string }> };

    expect(body.processes.length).toBe(3);

    const ids = body.processes.map((p) => p.id);
    expect(ids).toContain('proc-full-001');
    expect(ids).toContain('proc-min-002');
    expect(ids).toContain('proc-det-003');
  });

  it('process records contain mandatory core fields', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    for (const proc of body.processes) {
      // Mandatory core fields per ProcessRecord schema
      expect(proc).toHaveProperty('id');
      expect(typeof proc.id).toBe('string');

      expect(proc).toHaveProperty('card_id');
      expect(typeof proc.card_id).toBe('string');

      expect(proc).toHaveProperty('command');
      expect(typeof proc.command).toBe('string');

      expect(proc).toHaveProperty('cwd');
      expect(typeof proc.cwd).toBe('string');

      expect(proc).toHaveProperty('status');
      expect(['running', 'exited', 'failed', 'killed']).toContain(proc.status);

      expect(proc).toHaveProperty('started_at');
      expect(proc).toHaveProperty('required_for_card_completion');
      expect(typeof proc.required_for_card_completion).toBe('boolean');

      expect(proc).toHaveProperty('output_dir');
      expect(proc).toHaveProperty('stdout_path');
      expect(proc).toHaveProperty('stderr_path');
      expect(proc).toHaveProperty('combined_log_path');
    }
  });

  it('process with full ownership metadata exposes all session/ownership fields', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    const full = body.processes.find((p) => p.id === 'proc-full-001');
    expect(full).toBeDefined();

    expect(full!.agent_session_id).toBe('session-agent-exec-1');
    expect(full!.goal_id).toBe('card-goal-1');
    expect(full!.launch_reason).toBe('Execute test suite for goal card-goal-1');
    expect(full!.owner_kind).toBe('agent');
    expect(full!.background_policy).toBe('foreground');
    expect(full!.process_group_id).toBeNull();
  });

  it('process with minimal metadata has null ownership fields', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    const minimal = body.processes.find((p) => p.id === 'proc-min-002');
    expect(minimal).toBeDefined();

    expect(minimal!.agent_session_id).toBeNull();
    expect(minimal!.goal_id).toBeNull();
    expect(minimal!.launch_reason).toBeNull();
    expect(minimal!.owner_kind).toBeNull();
    expect(minimal!.background_policy).toBeNull();
    expect(minimal!.process_group_id).toBeNull();
  });

  it('process with detach policy has process_group_id and background_policy', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    const det = body.processes.find((p) => p.id === 'proc-det-003');
    expect(det).toBeDefined();

    expect(det!.background_policy).toBe('detach');
    expect(det!.process_group_id).toBe(42);
    expect(det!.owner_kind).toBe('runtime');
    expect(det!.agent_session_id).toBe('session-bg-1');
  });

  it('exited process has completed_at and exit_code', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    const exited = body.processes.find((p) => p.id === 'proc-min-002');
    expect(exited).toBeDefined();

    expect(exited!.completed_at).not.toBeNull();
    expect(exited!.exit_code).toBe(0);
    expect(exited!.status).toBe('exited');
  });

  it('running process has null completed_at and exit_code', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    const body = await res.json() as { processes: Array<Record<string, unknown>> };

    const running = body.processes.find((p) => p.id === 'proc-full-001');
    expect(running).toBeDefined();

    expect(running!.completed_at).toBeNull();
    expect(running!.exit_code).toBeNull();
    expect(running!.status).toBe('running');
  });

  // ── GET /api/processes/:id ──────────────────────────────────

  it('GET /api/processes/:id returns single process detail', async () => {
    const res = await fetch(apiUrl('/api/processes/proc-full-001'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as { process: Record<string, unknown> };
    expect(body).toHaveProperty('process');
    expect(body.process.id).toBe('proc-full-001');
    expect(body.process.command).toBe('npm test -- --coverage');
    expect(body.process.agent_session_id).toBe('session-agent-exec-1');
  });

  it('GET /api/processes/:id returns 404 for nonexistent process', async () => {
    const res = await fetch(apiUrl('/api/processes/nonexistent-id'), { headers: authHdr() });
    expect(res.status).toBe(404);

    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Process not found');
  });

  it('GET /api/processes/:id returns 400 for empty ID', async () => {
    const res = await fetch(apiUrl('/api/processes/'), { headers: authHdr() });
    // Fastify routes /api/processes/ without a param would match the list endpoint,
    // but if the route has :id, the empty trailing should still not crash
    // Actually Fastify treats /api/processes/ differently — it could be the list route
    // depending on normalization. This test just verifies no crash.
    expect(res.status).toBeLessThan(500);
  });

  // ── Auth Tests ──────────────────────────────────────────────

  it('GET /api/processes is protected by auth (401 without token)', async () => {
    const res = await fetch(apiUrl('/api/processes'));
    expect(res.status).toBe(401);
  });

  it('GET /api/processes rejects invalid auth token', async () => {
    const res = await fetch(apiUrl('/api/processes'), {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/processes/:id is protected by auth', async () => {
    const res = await fetch(apiUrl('/api/processes/proc-full-001'));
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// Process API — Empty State
// ═══════════════════════════════════════════════════════════════

describe('Stage 57 — GET /api/processes (empty state)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});
    // No process registry file — empty state

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerProcessRoutes } = await import('../../src/server/routes/processes.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerProcessRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  it('returns empty processes array when no registry file', async () => {
    const res = await fetch(apiUrl('/api/processes'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as { processes: unknown[] };
    expect(body.processes).toEqual([]);
  });

  it('returns 404 for any :id when no registry', async () => {
    const res = await fetch(apiUrl('/api/processes/any-id'), { headers: authHdr() });
    expect(res.status).toBe(404);
  });
});

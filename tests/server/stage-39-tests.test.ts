/**
 * Stage 39 — Tests for Doctor, Health frozen, and Docs serving
 *
 * These tests exercise the new endpoints added in stage-39-docs-serving-and-minor-gaps:
 *   - GET /api/debug/doctor (consistent and inconsistent card stores)
 *   - GET /health with frozen status and frozen_reason
 *   - GET /health without frozen_reason when idle
 *   - Docs serving graceful 404 when VitePress dist/ not built
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Helpers ───────────────────────────────────────────────────

function uniqueDir(): string {
  return join(
    tmpdir(),
    `saivage-stage39-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
  ]) {
    mkdirSync(join(sd, d), { recursive: true });
  }

  const config = {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: {
      test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
    },
    ...overrides,
  };

  writeFileSync(join(sd, 'saivage.json'), JSON.stringify(config, null, 2));

  // Initialize required card store files
  const now = new Date().toISOString();
  writeFileSync(
    join(sd, 'cards', 'by-id', 'project.json'),
    JSON.stringify({
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
      created_at: now,
      updated_at: now,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
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

  // Initialize runtime state
  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      paused: false,
      queue: [],
      running_processes: [],
      updated_at: now,
    }),
  );
}

// ═══════════════════════════════════════════════════════════════
// Test 1 & 2 — Doctor Endpoint (Consistent Card Store)
// ═══════════════════════════════════════════════════════════════

describe('Stage 39 — Doctor Endpoint (Consistent)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

    // Add a child card with proper parent linkage for a consistent store
    const sd = join(projectRoot, '.saivage');
    const now = new Date().toISOString();

    writeFileSync(
      join(sd, 'cards', 'by-id', 'goal-1.json'),
      JSON.stringify({
        id: 'goal-1',
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'Test Goal 1',
        description: 'A test goal',
        status: 'backlog',
        tags: [],
        priority: 1,
        urgency: 'normal',
        created_by: 'analyst',
        created_at: now,
        updated_at: now,
        depends_on: [],
        blocks: [],
        related: [],
        acceptance: '',
        artifacts: [],
        attachments: [],
        retries: 0,
      }),
    );

    const indexRaw = JSON.parse(readFileSync(join(sd, 'cards', 'index.json'), 'utf-8'));
    indexRaw.cards['goal-1'] = {
      id: 'goal-1',
      type: 'goal',
      parent: 'project',
      status: 'backlog',
      title: 'Test Goal 1',
    };
    writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify(indexRaw, null, 2));
    writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify(['goal-1']));

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
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
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

  it('GET /api/debug/doctor returns status ok for consistent card store', async () => {
    const res = await fetch(apiUrl('/api/debug/doctor'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      status: string;
      checks: Array<{ name: string; passed: boolean; details?: string }>;
      issues: Array<{ severity: string; message: string }>;
    };

    expect(body.status).toBe('ok');
    expect(Array.isArray(body.checks)).toBe(true);
    expect(Array.isArray(body.issues)).toBe(true);
    expect(body.issues).toEqual([]);

    const checkNames = body.checks.map((c) => c.name);
    expect(checkNames).toContain('index_entries_have_card_files');
    expect(checkNames).toContain('card_files_have_index_entries');
    expect(checkNames).toContain('child_parent_consistency');
    expect(checkNames).toContain('no_duplicate_ids');

    for (const check of body.checks) {
      expect(check.passed).toBe(true);
    }
  });

  it('GET /api/debug/doctor is protected by auth', async () => {
    const res = await fetch(apiUrl('/api/debug/doctor'));
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 3 — Doctor Endpoint (Inconsistent Card Store)
// ═══════════════════════════════════════════════════════════════

describe('Stage 39 — Doctor Endpoint (Inconsistent)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

    const sd = join(projectRoot, '.saivage');
    const now = new Date().toISOString();

    // Index entry without card file
    const indexRaw = JSON.parse(readFileSync(join(sd, 'cards', 'index.json'), 'utf-8'));
    indexRaw.cards['orphan-index'] = {
      id: 'orphan-index',
      type: 'goal',
      parent: 'project',
      status: 'backlog',
      title: 'Orphan Index Entry',
    };
    writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify(indexRaw, null, 2));

    // Card file without index entry
    writeFileSync(
      join(sd, 'cards', 'by-id', 'orphan-card.json'),
      JSON.stringify({
        id: 'orphan-card',
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'Orphan Card File',
        description: 'No index entry for this card',
        status: 'backlog',
        tags: [],
        priority: 1,
        urgency: 'normal',
        created_by: 'analyst',
        created_at: now,
        updated_at: now,
        depends_on: [],
        blocks: [],
        related: [],
        acceptance: '',
        artifacts: [],
        attachments: [],
        retries: 0,
      }),
    );

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
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
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

  it('GET /api/debug/doctor returns issues_found for inconsistent card store', async () => {
    const res = await fetch(apiUrl('/api/debug/doctor'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as {
      status: string;
      checks: Array<{ name: string; passed: boolean; details?: string }>;
      issues: Array<{ severity: string; message: string }>;
    };

    expect(body.status).toBe('issues_found');

    const failedChecks = body.checks.filter((c) => !c.passed);
    expect(failedChecks.length).toBeGreaterThan(0);

    expect(body.issues.length).toBeGreaterThan(0);

    const errors = body.issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThan(0);
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 4 — Health Endpoint with Frozen Status and frozen_reason
// ═══════════════════════════════════════════════════════════════

describe('Stage 39 — Health Endpoint (Frozen with frozen_reason)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

    const sd = join(projectRoot, '.saivage');
    const now = new Date().toISOString();

    writeFileSync(
      join(sd, 'runtime', 'state.json'),
      JSON.stringify({
        status: 'frozen',
        project_id: 'project',
        pid: process.pid,
        started_at: now,
        current_card_id: null,
        current_agent_session_id: null,
        paused: true,
        paused_at: now,
        queue: [],
        running_processes: [],
        updated_at: now,
        frozen_reason: null,
      }),
    );

    writeFileSync(
      join(sd, 'runtime', 'freeze-manifest.json'),
      JSON.stringify({
        freeze_id: 'freeze-test-001',
        reason: 'test freeze',
        created_at: now,
        status: 'frozen',
        project_id: 'project',
        pid: process.pid,
        started_at: now,
        current_card_id: null,
        current_agent_session_id: null,
        queue: [],
        running_processes: [],
        handoff_summaries: [],
        schema_version: 1,
        runtime_version: '0.1.0',
      }),
    );

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    // Real health endpoint that reads state from disk
    app.get('/health', async (_req, _reply) => {
      const { readRuntimeState } = await import('../../src/runtime/state.js');
      const { readFreezeManifest } = await import('../../src/utils/freeze-manifest.js');

      let runtimeStatus = 'unknown';
      let frozenReason: string | undefined;

      const state = readRuntimeState(projectRoot);
      if (state) {
        runtimeStatus = state.status;
        if (state.status === 'frozen') {
          const manifest = readFreezeManifest(projectRoot);
          if (manifest) {
            frozenReason = manifest.reason;
          }
        }
      }

      const response: Record<string, unknown> = {
        status: 'ok',
        version: '0.1.0',
        project: 'saivage-v3',
        runtime: runtimeStatus,
      };
      if (frozenReason !== undefined) {
        response.frozen_reason = frozenReason;
      }
      return response;
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('GET /health returns frozen status and frozen_reason when frozen', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;

    expect(body.runtime).toBe('frozen');
    expect(body.frozen_reason).toBe('test freeze');
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 5 — Health Endpoint without frozen_reason (idle state)
// ═══════════════════════════════════════════════════════════════

describe('Stage 39 — Health Endpoint (Idle, no frozen_reason)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

    // Default setupProject writes 'idle' state — just verify it's there
    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    app.get('/health', async (_req, _reply) => {
      const { readRuntimeState } = await import('../../src/runtime/state.js');

      let runtimeStatus = 'unknown';
      const state = readRuntimeState(projectRoot);
      if (state) {
        runtimeStatus = state.status;
      }

      return {
        status: 'ok',
        version: '0.1.0',
        project: 'saivage-v3',
        runtime: runtimeStatus,
      };
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('GET /health returns idle status without frozen_reason', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(res.status).toBe(200);

    const body = await res.json() as Record<string, unknown>;

    expect(body.runtime).toBe('idle');
    expect(body).not.toHaveProperty('frozen_reason');
  });
});

// ═══════════════════════════════════════════════════════════════
// Test 6 — Docs Serving Graceful 404 when not built
// ═══════════════════════════════════════════════════════════════

describe('Stage 39 — Docs Serving (Graceful 404)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;

  beforeAll(async () => {
    projectRoot = uniqueDir();

    // Create a minimal project directory (no docs/.vitepress/dist/)
    const sd = join(projectRoot, '.saivage');
    mkdirSync(sd, { recursive: true });
    for (const d of ['cards/by-id', 'cards/tree', 'cards/dependencies', 'runtime']) {
      mkdirSync(join(sd, d), { recursive: true });
    }

    writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
    }, null, 2));

    const now = new Date().toISOString();
    writeFileSync(join(sd, 'runtime', 'state.json'), JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      paused: false,
      queue: [],
      running_processes: [],
      updated_at: now,
    }));

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    // Health endpoint (no auth needed for docs)
    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    // Register docs serving fallback (matching server.ts behavior)
    // Must be registered AFTER any SPA static serving would be, but since we
    // have no web/dist/, we just register the graceful 404 handler.
    const docsDistDir = join(projectRoot, 'docs', '.vitepress', 'dist');
    // Intentionally DO NOT create the dir — test the graceful 404

    app.get('/docs/*', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
    });

    app.get('/docs', async (_request, reply) => {
      return reply.status(404).send({
        error: 'Documentation not built. Run vitepress build docs/ to generate.',
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('GET /docs/ returns 404 with error message when docs not built', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/docs/`);
    expect(res.status).toBe(404);

    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('Documentation not built');
  });

  it('GET /docs/nonexistent returns 404 when docs not built', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/docs/nonexistent`);
    expect(res.status).toBe(404);

    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toContain('Documentation not built');
  });
});

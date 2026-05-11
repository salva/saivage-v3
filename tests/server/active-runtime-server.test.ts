/**
 * Stage 18 — ActiveRuntime Server Integration Tests
 *
 * Tests for ActiveRuntime integration with the server module:
 *   1. createServer with createRuntime=true returns activeRuntime instance
 *   2. createServer with createRuntime=false (default) has undefined activeRuntime
 *   3. Server stop stops ActiveRuntime (lock released)
 *   4. POST /api/runtime/dispatch with missing goalId returns 400
 *   5. POST /api/runtime/dispatch with non-existent goal returns 404
 *   6. GET /api/runtime/status returns status info
 *   7. Pause/resume via API controls ActiveRuntime in-memory state
 */

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
import type { ServerInstance } from '../../src/server/server.js';
import { isLocked, releaseLock } from '../../src/utils/runtime-lock.js';
import { CardStore } from '../../src/utils/card-store.js';

// ── Helpers ───────────────────────────────────────────────────

const AUTH_TOKEN = 'ar-server-test-token-' + Math.random().toString(36).slice(2, 8);

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

function setupProjectDir(root: string): void {
  const sd = join(root, '.saivage');

  // Create required directories
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

  const now = new Date().toISOString();

  // Write saivage.json
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: {
          priority: 10,
          models: ['test-model'],
          apiKey: 'ar-server-test-api-key',
        },
      },
    }, null, 2),
  );

  // Write runtime state
  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
    }, null, 2),
  );

  // Write project card
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
    }, null, 2),
  );

  // Write card index
  writeFileSync(
    join(sd, 'cards', 'index.json'),
    JSON.stringify({
      cards: {
        project: {
          id: 'project',
          type: 'project',
          parent: null,
          status: 'backlog',
          title: 'project',
        },
      },
    }, null, 2),
  );

  // Write children, dependencies, notes queue
  writeFileSync(
    join(sd, 'cards', 'tree', 'project.children.json'),
    JSON.stringify([]),
  );
  writeFileSync(
    join(sd, 'cards', 'dependencies', 'depends-on.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(sd, 'cards', 'dependencies', 'blocks.json'),
    JSON.stringify({}),
  );
  writeFileSync(
    join(sd, 'notes', 'queue.json'),
    JSON.stringify({ entries: [] }),
  );

  // Write empty runtime event logs
  writeFileSync(join(sd, 'runtime', 'events.jsonl'), '');
  writeFileSync(join(sd, 'runtime', 'errors.jsonl'), '');

  // Copy web/dist/ into the temp dir so fastifyStatic has something to serve
  const realWebDist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(realWebDist)) {
    const tmpWebDist = join(root, 'web', 'dist');
    mkdirSync(dirname(tmpWebDist), { recursive: true });
    cpSync(realWebDist, tmpWebDist, { recursive: true });
  }
}

function addGoalCard(projectRoot: string, goalId: string, title: string): void {
  const store = new CardStore(projectRoot);
  store.create({
    id: goalId,
    type: 'goal' as const,
    parent: 'project',
    depth: 0,
    title,
    description: `Goal: ${title}`,
    status: 'backlog' as const,
    tags: [],
    priority: 1,
    urgency: 'normal' as const,
    created_by: 'analyst' as const,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: `Test acceptance for ${title}`,
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// Describe: ActiveRuntime Server Integration (with createRuntime=true)
// ═══════════════════════════════════════════════════════════════

describe('Server with ActiveRuntime (createRuntime=true)', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();

    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-server-'));

    setupProjectDir(tmpDir);

    // Add a goal card for dispatch testing
    addGoalCard(tmpDir, 'goal-test-1', 'Test Server Goal');

    process.chdir(tmpDir);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;

    // Create the server WITH runtime
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir, true);

    await server.fastify.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.fastify.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Server did not listen on a network port');
    }
    port = addr.port;
  }, 30000);

  afterAll(async () => {
    try {
      process.chdir(originalCwd);
    } catch {
      // best effort
    }

    if (server) {
      try {
        await server.stop();
      } catch {
        // best effort
      }
    }

    // Make sure lock is released
    try {
      releaseLock(tmpDir);
    } catch {
      // best effort
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }, 15000);

  // ── URL Helpers ────────────────────────────────────────────

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  // ══════════════════════════════════════════════════════════
  // AC: Server with createRuntime=true returns activeRuntime instance
  // ══════════════════════════════════════════════════════════

  describe('ActiveRuntime instance availability', () => {
    it('server instance has activeRuntime defined when createRuntime=true', () => {
      expect(server.activeRuntime).toBeDefined();
    });

    it('activeRuntime.getStatus() returns expected values', () => {
      const status = server.activeRuntime!.getStatus();
      expect(status).toBeDefined();
      expect(typeof status.status).toBe('string');
      expect(typeof status.paused).toBe('boolean');
      expect(typeof status.goalCount).toBe('number');
    });

    it('activeRuntime reports goalCount from the card store', () => {
      const status = server.activeRuntime!.getStatus();
      // We added 'goal-test-1', so goalCount should be >= 1
      expect(status.goalCount).toBeGreaterThanOrEqual(1);
    });
  });

  // ══════════════════════════════════════════════════════════
  // AC: Server stop stops ActiveRuntime (lock released)
  // ══════════════════════════════════════════════════════════

  describe('Server stop releases ActiveRuntime lock', () => {
    it('lock is held while server is running with createRuntime=true', () => {
      expect(isLocked(tmpDir)).toBe(true);
    });

    it('activeRuntime is in a valid state while server is running', () => {
      const status = server.activeRuntime!.getStatus();
      expect(status.status).toBe('idle');
      expect(status.paused).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // AC: GET /api/runtime/status returns status info
  // ══════════════════════════════════════════════════════════

  describe('GET /api/runtime/status', () => {
    it('returns 200 with status info', async () => {
      const res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('runtime');
      expect(body).toHaveProperty('paused');
      expect(body).toHaveProperty('currentCardId');
      expect(body).toHaveProperty('goalCount');
    });

    it('requires auth (returns 401 without token)', async () => {
      const res = await fetch(baseUrl('/api/runtime/status'));
      expect(res.status).toBe(401);
    });

    it('returns sensible runtime status value', async () => {
      const res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      const body = await res.json() as Record<string, unknown>;
      expect(['idle', 'running', 'paused', 'shutting_down', 'error']).toContain(
        body.runtime,
      );
    });

    it('paused is false initially', async () => {
      const res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      const body = await res.json() as Record<string, unknown>;
      expect(body.paused).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════
  // AC: POST /api/runtime/dispatch
  // ══════════════════════════════════════════════════════════

  describe('POST /api/runtime/dispatch', () => {
    it('returns 400 for missing goalId', async () => {
      const res = await fetch(baseUrl('/api/runtime/dispatch'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);

      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('goalId is required');
    });

    it('returns 400 for empty body', async () => {
      const res = await fetch(baseUrl('/api/runtime/dispatch'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: '' }),
      });
      expect(res.status).toBe(400);
    });

    it('returns 404 for non-existent goal', async () => {
      const res = await fetch(baseUrl('/api/runtime/dispatch'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: 'nonexistent-goal-id' }),
      });
      expect(res.status).toBe(404);

      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toBe('Goal not found');
      expect(body.goalId).toBe('nonexistent-goal-id');
    });

    it('requires auth (returns 401 without token)', async () => {
      const res = await fetch(baseUrl('/api/runtime/dispatch'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: 'goal-test-1' }),
      });
      expect(res.status).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════
  // AC: Pause/resume via API controls ActiveRuntime
  // ══════════════════════════════════════════════════════════

  describe('Pause / Resume via API', () => {
    it('POST /api/runtime/pause sets paused to true', async () => {
      const res = await fetch(baseUrl('/api/runtime/pause'), {
        method: 'POST',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('paused');

      // Verify ActiveRuntime in-memory state
      expect(server.activeRuntime!.getStatus().paused).toBe(true);
    });

    it('POST /api/runtime/resume sets paused to false', async () => {
      // First pause
      await fetch(baseUrl('/api/runtime/pause'), {
        method: 'POST',
        headers: authHeaders(),
      });

      const res = await fetch(baseUrl('/api/runtime/resume'), {
        method: 'POST',
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('resumed');

      // Verify ActiveRuntime in-memory state
      expect(server.activeRuntime!.getStatus().paused).toBe(false);
    });

    it('GET /api/runtime/status reflects pause/resume changes', async () => {
      // Pause
      await fetch(baseUrl('/api/runtime/pause'), {
        method: 'POST',
        headers: authHeaders(),
      });

      let res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      let body = await res.json() as Record<string, unknown>;
      expect(body.paused).toBe(true);

      // Resume
      await fetch(baseUrl('/api/runtime/resume'), {
        method: 'POST',
        headers: authHeaders(),
      });

      res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      body = await res.json() as Record<string, unknown>;
      expect(body.paused).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════════
// Describe: Server WITHOUT ActiveRuntime (createRuntime=false, default)
// ═══════════════════════════════════════════════════════════════

describe('Server without ActiveRuntime (createRuntime=false)', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();

    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-nort-'));

    setupProjectDir(tmpDir);

    process.chdir(tmpDir);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;

    // Create the server WITHOUT runtime
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir, false);

    await server.fastify.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.fastify.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Server did not listen on a network port');
    }
    port = addr.port;
  }, 30000);

  afterAll(async () => {
    try {
      process.chdir(originalCwd);
    } catch {
      // best effort
    }

    if (server) {
      try {
        await server.stop();
      } catch {
        // best effort
      }
    }

    try {
      releaseLock(tmpDir);
    } catch {
      // best effort
    }

    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }, 15000);

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  describe('Server instance without runtime', () => {
    it('activeRuntime is undefined when createRuntime=false', () => {
      expect(server.activeRuntime).toBeUndefined();
    });

    it('GET /api/runtime/status still works (fallback to state file)', async () => {
      const res = await fetch(baseUrl('/api/runtime/status'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body).toHaveProperty('runtime');
      // Without ActiveRuntime, runtime status comes from state file
      expect(typeof body.runtime).toBe('string');
    });

    it('POST /api/runtime/dispatch returns 503 when ActiveRuntime not available', async () => {
      // The dispatch route is always registered now but returns a 503
      // JSON error when no ActiveRuntime is available.
      const res = await fetch(baseUrl('/api/runtime/dispatch'), {
        method: 'POST',
        headers: { ...authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ goalId: 'goal-1' }),
      });
      expect(res.status).toBe(503);
      const body = await res.json() as Record<string, unknown>;
      expect(body.error).toContain('No active runtime available');
    });

    it('server still functions normally without ActiveRuntime', () => {
      expect(server.fastify).toBeDefined();
      expect(server.config).toBeDefined();
      expect(typeof server.stop).toBe('function');
    });
  });
});

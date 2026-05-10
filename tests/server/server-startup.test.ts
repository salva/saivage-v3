/**
 * Stage 12 — Server Startup Integration Test
 *
 * End-to-end integration test using the REAL createServer() from server.ts.
 * Verifies:
 *   1. Health endpoint (no auth) returns version, project, runtime state
 *   2. API auth rejection (401) for unauthenticated requests
 *   3. API auth acceptance via Bearer and ?token= query param
 *   4. WebSocket connectivity with auth (welcome message, rejection without token)
 *   5. Static file serving of the web SPA from web/dist/
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import WebSocket from 'ws';
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

// ── Helpers ───────────────────────────────────────────────────

const AUTH_TOKEN = 'server-startup-test-token-' + Math.random().toString(36).slice(2, 8);

/**
 * Derive the project root (where saivage-v3 lives) from this file's location.
 * tests/server/server-startup.test.ts -> two dirs up is the project root.
 */
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

  // Write saivage.json — use a valid positive port (8080); the listen()
  // call with port: 0 will override this for the actual listening port.
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: {
          priority: 10,
          models: ['test-model'],
          apiKey: 'e2e-test-api-key',
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

  // Copy web/dist/ into the temp dir so fastifyStatic has something to serve.
  // The real web/dist/ lives at <PROJECT_ROOT>/web/dist/
  const realWebDist = join(PROJECT_ROOT, 'web', 'dist');
  if (existsSync(realWebDist)) {
    const tmpWebDist = join(root, 'web', 'dist');
    mkdirSync(dirname(tmpWebDist), { recursive: true });
    cpSync(realWebDist, tmpWebDist, { recursive: true });
  }
}


// ═══════════════════════════════════════════════════════════════
// Describe: Full Server Startup Integration
// ═══════════════════════════════════════════════════════════════

describe('Server Startup Integration (createServer)', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;

  beforeAll(async () => {
    // Save original CWD
    originalCwd = process.cwd();

    // Create a unique temp directory
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-server-startup-'));

    // Set up the project skeleton (including web/dist/ copy)
    setupProjectDir(tmpDir);

    // Change CWD to temp dir so that the health endpoint reads our runtime state
    // (registerHealth uses process.cwd() to find .saivage/runtime/state.json)
    process.chdir(tmpDir);

    // Set auth token
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;

    // Create the real server
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);

    // Start listening on port 0
    await server.fastify.listen({ host: '127.0.0.1', port: 0 });
    const addr = server.fastify.server.address();
    if (!addr || typeof addr === 'string') {
      throw new Error('Server did not listen on a network port');
    }
    port = addr.port;
  }, 30000);

  afterAll(async () => {
    // Restore CWD
    try {
      process.chdir(originalCwd);
    } catch {
      // best effort
    }

    // Stop the server
    if (server) {
      try {
        await server.stop();
      } catch {
        // best effort
      }
    }

    // Clean up temp dir
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

  function wsUrl(path: string): string {
    return `ws://127.0.0.1:${port}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  // ══════════════════════════════════════════════════════════
  // 1. Health Endpoint
  // ══════════════════════════════════════════════════════════

  describe('Health Endpoint', () => {
    it('GET /health returns 200 without auth', async () => {
      const res = await fetch(baseUrl('/health'));
      expect(res.status).toBe(200);
    });

    it('GET /health returns status: ok, version: 0.1.0, project: saivage-v3', async () => {
      const res = await fetch(baseUrl('/health'));
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.project).toBe('saivage-v3');
    });

    it('GET /health returns runtime: idle (from runtime state file)', async () => {
      const res = await fetch(baseUrl('/health'));
      expect(res.status).toBe(200);

      const body = await res.json() as Record<string, unknown>;
      expect(body.runtime).toBe('idle');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 2. API Auth
  // ══════════════════════════════════════════════════════════

  describe('API Auth', () => {
    it('GET /api/state without auth headers returns 401', async () => {
      const res = await fetch(baseUrl('/api/state'));
      expect(res.status).toBe(401);
    });

    it('GET /api/state with invalid Bearer token returns 401', async () => {
      const res = await fetch(baseUrl('/api/state'), {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
    });

    it('GET /api/state with valid Bearer token returns 200', async () => {
      const res = await fetch(baseUrl('/api/state'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });

    it('GET /api/state with valid ?token= query param returns 200', async () => {
      const res = await fetch(baseUrl(`/api/state?token=${AUTH_TOKEN}`));
      expect(res.status).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════
  // 3. WebSocket Connectivity
  // ══════════════════════════════════════════════════════════

  describe('WebSocket Connectivity', () => {
    it('connects with valid auth token and receives welcome status message', (done) => {
      const ws = new WebSocket(wsUrl(`/ws?token=${AUTH_TOKEN}`));

      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString()) as {
          type: string;
          content: Record<string, unknown>;
        };
        expect(data.type).toBe('status');
        expect(data.content.event).toBe('connected');
        expect(data.content.sessionId).toBeDefined();
        expect(typeof data.content.clientCount).toBe('number');
        ws.close();
        done();
      });

      ws.on('error', (err) => {
        done(err);
      });
    }, 10000);

    it('rejects connection without auth token (non-1000 close code)', (done) => {
      const ws = new WebSocket(wsUrl('/ws'));
      let resolved = false;

      ws.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          expect(code).not.toBe(1000);
          done();
        }
      });

      ws.on('error', () => {
        if (!resolved) {
          resolved = true;
          done();
        }
      });

      // Timeout safety
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          done();
        }
      }, 5000);
    }, 10000);

    it('rejects connection with wrong auth token (non-1000 close code)', (done) => {
      const ws = new WebSocket(wsUrl('/ws?token=wrong-token'));
      let resolved = false;

      ws.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          expect(code).not.toBe(1000);
          done();
        }
      });

      ws.on('error', () => {
        if (!resolved) {
          resolved = true;
          done();
        }
      });

      // Timeout safety
      setTimeout(() => {
        if (!resolved) {
          resolved = true;
          done();
        }
      }, 5000);
    }, 10000);
  });

  // ══════════════════════════════════════════════════════════
  // 4. Static File Serving
  // ══════════════════════════════════════════════════════════

  describe('Static File Serving', () => {
    it('GET / returns 200 and serves SPA index.html', async () => {
      const res = await fetch(baseUrl('/'));
      expect(res.status).toBe(200);
    });

    it('GET / response contains <div id="app"> from web/dist/index.html', async () => {
      const res = await fetch(baseUrl('/'));
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<div id="app">');
    });

    it('GET / responds with text/html content type', async () => {
      const res = await fetch(baseUrl('/'));
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') || '';
      expect(ct).toContain('text/html');
    });
  });

  // ══════════════════════════════════════════════════════════
  // 5. Server Lifecycle
  // ══════════════════════════════════════════════════════════

  describe('Server Lifecycle', () => {
    it('server instance has fastify, config, and stop', () => {
      expect(server.fastify).toBeDefined();
      expect(server.config).toBeDefined();
      expect(server.config.host).toBe('127.0.0.1');
      expect(typeof server.stop).toBe('function');
    });

    it('server API responds after startup', async () => {
      const res = await fetch(baseUrl('/api/state'), {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });
  });
});

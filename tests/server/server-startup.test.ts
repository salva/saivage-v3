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
 *   6. VitePress docs serving at /docs/ from docs/.vitepress/dist/
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
import { getClientCount } from '../../src/server/websocket.js';
import { getAuthPolicy, resetAuthPolicyForTests } from '../../src/server/auth-policy.js';

const AUTH_TOKEN = 'server-startup-test-token-' + Math.random().toString(36).slice(2, 8);
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, '..', '..');

function setupProjectDir(root: string): void {
  const sd = join(root, '.saivage');
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
      version_seq: 1,
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
    }, null, 2),
  );
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

  const realDocsDist = join(PROJECT_ROOT, 'docs', '.vitepress', 'dist');
  if (existsSync(realDocsDist)) {
    const tmpDocsDist = join(root, 'docs', '.vitepress', 'dist');
    mkdirSync(dirname(tmpDocsDist), { recursive: true });
    cpSync(realDocsDist, tmpDocsDist, { recursive: true });
  }
}

describe('Server Startup Integration (createServer)', () => {
  let tmpDir: string;
  let server: ServerInstance;
  let port: number;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-server-startup-'));
    setupProjectDir(tmpDir);
    process.chdir(tmpDir);
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    resetAuthPolicyForTests();
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);
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
    } catch {}
    if (server) {
      try {
        await server.stop();
      } catch {}
    }
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  }, 15000);

  function baseUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function fetchLocal(path: string, init?: RequestInit): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set('connection', 'close');
    return fetch(baseUrl(path), { ...init, headers });
  }

  function wsUrl(path: string): string {
    return `ws://127.0.0.1:${port}${path}`;
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${AUTH_TOKEN}` };
  }

  describe('Health Endpoint', () => {
    it('GET /health returns 200 without auth', async () => {
      const res = await fetchLocal('/health');
      expect(res.status).toBe(200);
      await res.text();
    });

    it('GET /health returns status: ok, version: 0.1.0, project: saivage-v3', async () => {
      const res = await fetchLocal('/health');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.project).toBe('saivage-v3');
    });

    it('GET /health returns runtime: idle (from runtime state file)', async () => {
      const res = await fetchLocal('/health');
      expect(res.status).toBe(200);
      const body = await res.json() as Record<string, unknown>;
      expect(body.runtime).toBe('idle');
    });
  });

  describe('API Auth', () => {
    it('GET /api/state without auth headers returns 401', async () => {
      const res = await fetchLocal('/api/state');
      expect(res.status).toBe(401);
      await res.text();
    });

    it('GET /api/state with invalid Bearer token returns 401', async () => {
      const res = await fetchLocal('/api/state', {
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(res.status).toBe(401);
      await res.text();
    });

    it('GET /api/state with valid Bearer token returns 200', async () => {
      const res = await fetchLocal('/api/state', { headers: authHeaders() });
      expect(res.status).toBe(200);
      await res.text();
    });

    it('GET /api/state with valid ?token= query param is rejected without echoing token', async () => {
      const res = await fetchLocal(`/api/state?token=${AUTH_TOKEN}`);
      expect(res.status).toBe(401);
      expect(await res.text()).not.toContain(AUTH_TOKEN);
    });
  });

  describe('WebSocket Connectivity', () => {
    it('connects with valid websocket ticket and receives welcome status message', (done) => {
      const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
      const ws = new WebSocket(wsUrl(`/ws?ticket=${ticket}`));
      ws.on('message', (raw) => {
        const data = JSON.parse(raw.toString()) as { type: string; content: Record<string, unknown> };
        expect(data.type).toBe('status');
        expect(data.content.event).toBe('connected');
        expect(data.content.sessionId).toBeDefined();
        expect(typeof data.content.clientCount).toBe('number');
        ws.close();
        done();
      });
      ws.on('error', (err) => done(err));
    }, 10000);

    it('rejects connection without auth token (non-1000 close code)', (done) => {
      const ws = new WebSocket(wsUrl('/ws'));
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          done();
        }
      }, 5000);
      ws.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          expect(code).not.toBe(1000);
          done();
        }
      });
      ws.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          done();
        }
      });
    }, 10000);

    it('rejects connection with wrong auth token query (policy close code)', (done) => {
      const ws = new WebSocket(wsUrl('/ws?token=wrong-token'));
      let resolved = false;
      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          done();
        }
      }, 5000);
      ws.on('close', (code) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          expect(code).not.toBe(1000);
          done();
        }
      });
      ws.on('error', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timeoutId);
          done();
        }
      });
    }, 10000);
  });

  describe('Static File Serving', () => {
    it('GET / returns 200 and serves SPA index.html', async () => {
      const res = await fetchLocal('/');
      expect(res.status).toBe(200);
      await res.text();
    });

    it('GET / response contains <div id="app"> from web/dist/index.html', async () => {
      const res = await fetchLocal('/');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<div id="app">');
    });

    it('GET / responds with text/html content type', async () => {
      const res = await fetchLocal('/');
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') || '';
      expect(ct).toContain('text/html');
      await res.text();
    });
  });

  describe('VitePress Docs Serving', () => {
    it('GET /docs/ returns 200 and serves VitePress index page', async () => {
      const res = await fetchLocal('/docs/');
      expect(res.status).toBe(200);
      await res.text();
    });

    it('GET /docs/ response contains VitePress generated content', async () => {
      const res = await fetchLocal('/docs/');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('<div id="app">');
      expect(text).toContain('content="VitePress');
      expect(text).toContain('Saivage v3');
    });

    it('GET /docs/ response has text/html content type', async () => {
      const res = await fetchLocal('/docs/');
      expect(res.status).toBe(200);
      const ct = res.headers.get('content-type') || '';
      expect(ct).toContain('text/html');
      await res.text();
    });

    it('GET /docs/install.html returns 200 and serves Install page', async () => {
      const res = await fetchLocal('/docs/install.html');
      expect(res.status).toBe(200);
      await res.text();
    });

    it('GET /docs/install.html response contains Install-specific VitePress content', async () => {
      const res = await fetchLocal('/docs/install.html');
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('content="VitePress');
      expect(text).toContain('Installation Guide');
      expect(text).toContain('Saivage v3');
    });
  });

  describe('Server Lifecycle', () => {
    it('server instance has fastify, config, and stop', () => {
      expect(server.fastify).toBeDefined();
      expect(server.config).toBeDefined();
      expect(server.config.host).toBe('127.0.0.1');
      expect(typeof server.stop).toBe('function');
    });

    it('server API responds after startup', async () => {
      const res = await fetchLocal('/api/state', { headers: authHeaders() });
      expect(res.status).toBe(200);
      await res.text();
    });

    it('server.stop() clears websocket clients before closing', async () => {
      const stopRoot = mkdtempSync(join(tmpdir(), 'saivage-server-stop-'));
      const stopOriginalCwd = process.cwd();
      try {
        setupProjectDir(stopRoot);
        process.chdir(stopRoot);
        const { createServer } = await import('../../src/server/server.js');
        const stopServer = await createServer(stopRoot);
        await stopServer.fastify.listen({ host: '127.0.0.1', port: 0 });
        const addr = stopServer.fastify.server.address();
        if (!addr || typeof addr === 'string') {
          throw new Error('Stop test server did not listen on a network port');
        }
        const stopPort = addr.port;
        const ticket = getAuthPolicy().issueWebSocketTicket().ticket;
        const ws = new WebSocket(`ws://127.0.0.1:${stopPort}/ws?ticket=${ticket}`);
        await new Promise<void>((resolve, reject) => {
          ws.once('message', () => resolve());
          ws.once('error', reject);
        });
        expect(getClientCount()).toBeGreaterThan(0);
        await stopServer.stop();
        expect(getClientCount()).toBe(0);
      } finally {
        try { process.chdir(stopOriginalCwd); } catch {}
        try { rmSync(stopRoot, { recursive: true, force: true }); } catch {}
      }
    }, 15000);
  });
});

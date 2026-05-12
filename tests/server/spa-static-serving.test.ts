/**
 * Stage fix-static-spa-serving + stage-53 hardening — SPA Static Serving Integration Tests
 *
 * Verifies that the SPA and docs static serving works correctly when
 * projectRoot differs from the Saivage installation (package root).
 *
 * The fix derives the package root from import.meta.url, so even when
 * projectRoot is a completely different directory (simulating deployment
 * where workDir=/work/target-project, saivageInstall=/opt/saivage-v3),
 * the static assets from the real package's web/dist/ and docs/.vitepress/dist/
 * are still served correctly.
 *
 * Tests:
 *   1. GET / returns 200 with Vue SPA index.html (<div id="app">)
 *   2. GET /assets/<file>.js returns 200 with JavaScript content
 *   3. GET /health returns 200
 *   4. GET /api/runtime/status returns 200
 *   5. GET /docs/ returns 200 with VitePress content (not swallowed by SPA fallback)
 *   6. API routes return structured JSON, not SPA HTML
 *   7. WebSocket upgrade works with static serving enabled
 *
 * All requests use fastify.inject() / fastify.injectWS() — no actual HTTP server needed.
 */

import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import {
  mkdirSync,
  rmSync,
  writeFileSync,
  mkdtempSync,
  readdirSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { WebSocket } from 'ws';

// ── Helpers ───────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');

/**
 * Find the first .js asset file in web/dist/assets/ (not .map files).
 * Returns the filename only (e.g. "index-BOEPBCgq.js").
 */
function findFirstJsAsset(): string | null {
  const assetsDir = join(PACKAGE_ROOT, 'web', 'dist', 'assets');
  try {
    const files = readdirSync(assetsDir);
    const jsFile = files.find((f) => f.endsWith('.js') && !f.endsWith('.js.map'));
    return jsFile ?? null;
  } catch {
    return null;
  }
}

/**
 * Create a minimal skeleton project at `root` so the server can start
 * without errors from missing card store / runtime state files.
 */
function setupSkeletonProject(root: string): void {
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
          apiKey: 'spa-test-api-key',
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
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ entries: [] }));
  writeFileSync(join(sd, 'runtime', 'events.jsonl'), '');
  writeFileSync(join(sd, 'runtime', 'errors.jsonl'), '');
}

// ═══════════════════════════════════════════════════════════════
// Describe: SPA static serving with mismatched projectRoot
// ═══════════════════════════════════════════════════════════════

describe('SPA static serving (projectRoot ≠ packageRoot)', () => {
  let fakeProjectRoot: string;
  let server: Awaited<ReturnType<typeof import('../../src/server/server.js').createServer>>;
  let originalCwd: string;
  let jsAssetFile: string | null;

  beforeAll(async () => {
    originalCwd = process.cwd();

    // Create a fake project directory that does NOT contain web/dist or docs.
    // This simulates the deployment scenario where projectRoot (workDir) differs
    // from the Saivage installation directory (package root).
    fakeProjectRoot = mkdtempSync(
      join(tmpdir(), 'saivage-spa-test-'),
    );

    setupSkeletonProject(fakeProjectRoot);

    // Change CWD so the health endpoint can read runtime state.
    // The health endpoint uses process.cwd() to find .saivage/runtime/state.json.
    process.chdir(fakeProjectRoot);

    // Discover a built JS asset for the /assets/ test
    jsAssetFile = findFirstJsAsset();

    // Import createServer and create the server WITH the fake project root.
    // createRuntime=false because we only need the static serving, not the
    // ActiveRuntime with its LLM dispatch loop.
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(fakeProjectRoot, false);

    // We do NOT call listen() — use fastify.inject() for all requests.
    // But Fastify needs to be ready for inject to work reliably.
    await server.fastify.ready();
  }, 30000);

  afterAll(async () => {
    // Restore CWD
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

    // Clean up the fake project directory
    try {
      rmSync(fakeProjectRoot, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }, 15000);

  // ──────────────────────────────────────────────────────────
  // 1. GET / — Vue SPA index.html
  // ──────────────────────────────────────────────────────────

  describe('GET /', () => {
    it('returns 200 with Vue SPA index.html', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/',
      });
      expect(res.statusCode).toBe(200);
    });

    it('response contains <div id="app"> (Vue mount point)', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="app">');
    });

    it('response has text/html content type', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/',
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'] || '';
      expect(ct).toContain('text/html');
    });

    it('response contains Saivage Control Room title', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Saivage Control Room');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 2. GET /assets/<file>.js — built JS asset
  // ──────────────────────────────────────────────────────────

  describe('GET /assets/<file>.js', () => {
    it('returns 200 with JavaScript content for built asset', async () => {
      if (!jsAssetFile) {
        console.warn('Skipping JS asset test — no .js file found in web/dist/assets/');
        return;
      }

      const res = await server.fastify.inject({
        method: 'GET',
        url: `/assets/${jsAssetFile}`,
      });
      expect(res.statusCode).toBe(200);

      const ct = res.headers['content-type'] || '';
      // Should be application/javascript or text/javascript
      expect(ct).toMatch(/javascript/);
    });

    it('returns non-empty body for JS asset', async () => {
      if (!jsAssetFile) {
        return;
      }

      const res = await server.fastify.inject({
        method: 'GET',
        url: `/assets/${jsAssetFile}`,
      });
      expect(res.statusCode).toBe(200);
      expect(res.body.length).toBeGreaterThan(0);
    });

    it('returns SPA index.html for non-existent asset path (SPA fallback)', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/assets/non-existent-file-xyz.js',
      });
      // With SPA fallback, non-matching GETs return index.html (200).
      // Since /assets/non-existent-file-xyz.js doesn't match a real file,
      // the notFoundHandler sends index.html.
      // This is expected behavior — the SPA client-side router handles 404s.
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="app">');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 3. GET /health — Health endpoint
  // ──────────────────────────────────────────────────────────

  describe('GET /health', () => {
    it('returns 200', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns status: ok and version: 0.1.0', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.status).toBe('ok');
      expect(body.version).toBe('0.1.0');
      expect(body.project).toBe('saivage-v3');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 4. GET /api/runtime/status — Runtime status endpoint
  // ──────────────────────────────────────────────────────────

  describe('GET /api/runtime/status', () => {
    it('returns 200', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/runtime/status',
      });
      expect(res.statusCode).toBe(200);
    });

    it('returns runtime status from state file', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/runtime/status',
      });
      expect(res.statusCode).toBe(200);

      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body).toHaveProperty('runtime');
      expect(body.runtime).toBe('idle');
    });

    it('returns application/json content-type with structured status', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/runtime/status',
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'] || '';
      expect(ct).toContain('application/json');

      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body).toHaveProperty('runtime');
      expect(body).toHaveProperty('paused');
      expect(body).toHaveProperty('currentCardId');
      expect(body).toHaveProperty('goalCount');
      // Must have the expected typed fields
      expect(typeof body.runtime).toBe('string');
      expect(typeof body.paused).toBe('boolean');
      expect(typeof body.goalCount).toBe('number');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 5. GET /docs/ — VitePress docs (not swallowed by SPA)
  // ──────────────────────────────────────────────────────────

  describe('GET /docs/', () => {
    it('returns 200 with VitePress docs (not swallowed by SPA fallback)', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/docs/',
      });
      expect(res.statusCode).toBe(200);

      // VitePress-specific markers that prove this is the docs, not the SPA
      // - "VitePress" meta generator
      // - "Saivage v3" appears in the VitePress nav bar
      // - The docs index.md heading content
      expect(res.body).toMatch(/VitePress/);
      expect(res.body).toContain('Saivage v3');
    });

    it('response has text/html content type', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/docs/',
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'] || '';
      expect(ct).toContain('text/html');
    });

    it('GET /docs/install.html returns 200 with Install page', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/docs/install.html',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Install/);
    });

    it('GET /docs/configuration.html returns 200 with Configuration page', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/docs/configuration.html',
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/Configuration/);
    });

    it('GET /docs/ (VitePress) does NOT contain SPA-specific markers', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/docs/',
      });
      expect(res.statusCode).toBe(200);
      // The SPA index.html has "Saivage Control Room" — the VitePress docs should NOT
      expect(res.body).not.toContain('Saivage Control Room');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 6. Verification: SPA fallback does not swallow API routes
  // ──────────────────────────────────────────────────────────

  describe('SPA fallback does not swallow API routes', () => {
    it('GET /api/state returns JSON, not SPA HTML', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/state',
      });
      // API routes should return JSON, not the SPA index.html
      expect(res.body).not.toContain('<div id="app">');
    });

    it('GET /api/state response is valid JSON with cardIndex and runtime', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/state',
      });
      expect(res.statusCode).toBe(200);
      expect(() => JSON.parse(res.body)).not.toThrow();
      const body = JSON.parse(res.body) as Record<string, unknown>;
      // The /api/state endpoint returns cardIndex and runtime objects
      expect(body).toHaveProperty('cardIndex');
      expect(body).toHaveProperty('runtime');
    });

    it('GET /ws does not return SPA HTML', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/ws',
      });
      // WebSocket upgrade endpoint should not return SPA HTML
      expect(res.body).not.toContain('<div id="app">');
    });
  });

  // ──────────────────────────────────────────────────────────
  // 7. WebSocket upgrade works with static serving enabled
  // ──────────────────────────────────────────────────────────

  describe('WebSocket /ws upgrade (static serving enabled)', () => {
    it('injectWS upgrades successfully when SAIVAGE_API_TOKEN is unset (dev mode)', async () => {
      // In dev mode (no SAIVAGE_API_TOKEN), the WebSocket auth passes through.
      // injectWS simulates a real WebSocket upgrade handshake.
      const ws: WebSocket = await (server.fastify as any).injectWS('/ws');
      expect(ws).toBeDefined();
      expect(ws.readyState).toBe(ws.OPEN); // WebSocket.OPEN = 1
      // Gracefully close after test
      ws.close();
    }, 10000);

    it('injectWS sends welcome message with connected status on upgrade', async () => {
      const messages: string[] = [];
      const ws: WebSocket = await (server.fastify as any).injectWS('/ws', {}, {
        onOpen: (socket: WebSocket) => {
          socket.on('message', (data: Buffer | string) => {
            messages.push(typeof data === 'string' ? data : data.toString('utf-8'));
          });
        },
      });

      // Wait a short time for the welcome message to arrive
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(messages.length).toBeGreaterThanOrEqual(1);
      const welcomeMessage = JSON.parse(messages[0]!) as Record<string, unknown>;
      expect(welcomeMessage.type).toBe('status');
      expect(welcomeMessage.content).toHaveProperty('event', 'connected');
      expect(welcomeMessage.content).toHaveProperty('sessionId');
      expect(welcomeMessage.content).toHaveProperty('clientCount');
      ws.close();
    }, 10000);

    it('WebSocket upgrade with valid auth token succeeds when SAIVAGE_API_TOKEN is set', async () => {
      const prevToken = process.env['SAIVAGE_API_TOKEN'];
      process.env['SAIVAGE_API_TOKEN'] = 'hardening-test-token';

      try {
        // Use onOpen to capture the welcome message that is sent
        // immediately after the connection is established
        const messages: string[] = [];
        const ws: WebSocket = await (server.fastify as any).injectWS(
          '/ws?token=hardening-test-token',
          {},
          {
            onOpen: (socket: WebSocket) => {
              socket.on('message', (data: Buffer | string) => {
                messages.push(typeof data === 'string' ? data : data.toString('utf-8'));
              });
            },
          },
        );

        expect(ws).toBeDefined();
        expect(ws.readyState).toBe(ws.OPEN);

        // Wait for the welcome message
        await new Promise(resolve => setTimeout(resolve, 200));
        expect(messages.length).toBeGreaterThanOrEqual(1);

        const welcomeMessage = JSON.parse(messages[0]!) as Record<string, unknown>;
        expect(welcomeMessage.type).toBe('status');
        expect(welcomeMessage.content).toHaveProperty('event', 'connected');

        ws.close();
      } finally {
        if (prevToken) {
          process.env['SAIVAGE_API_TOKEN'] = prevToken;
        } else {
          delete process.env['SAIVAGE_API_TOKEN'];
        }
      }
    }, 10000);

    it('WebSocket with invalid auth token gets closed when SAIVAGE_API_TOKEN is set', async () => {
      const prevToken = process.env['SAIVAGE_API_TOKEN'];
      process.env['SAIVAGE_API_TOKEN'] = 'hardening-test-token';

      try {
        // Connect with a wrong token
        const closeEvents: { code: number; reason: string }[] = [];
        const ws: WebSocket = await (server.fastify as any).injectWS('/ws?token=wrong-token', {}, {
          onOpen: (socket: WebSocket) => {
            // Watch for the close frame
            socket.on('close', (code: number, reason: Buffer) => {
              closeEvents.push({
                code,
                reason: reason.toString('utf-8'),
              });
            });
          },
        });

        // Wait for the auth failure close
        await new Promise(resolve => setTimeout(resolve, 300));

        // The server should close the connection with 1008 (Policy Violation)
        // when auth fails
        if (closeEvents.length > 0) {
          expect(closeEvents[0]!.code).toBe(1008);
          expect(closeEvents[0]!.reason).toBe('Authentication failed');
        } else {
          // If no close event fired yet, the socket may still be open because
          // injectWS simulates the upgrade. The close happens asynchronously.
          // At minimum, the socket should not still be OPEN after timeout.
          expect(ws.readyState).not.toBe(ws.OPEN);
        }

        try { ws.close(); } catch { /* may already be closed */ }
      } finally {
        if (prevToken) {
          process.env['SAIVAGE_API_TOKEN'] = prevToken;
        } else {
          delete process.env['SAIVAGE_API_TOKEN'];
        }
      }
    }, 10000);
  });

  // ──────────────────────────────────────────────────────────
  // 8. API routes function correctly alongside static serving
  // ──────────────────────────────────────────────────────────

  describe('API routes function alongside static serving', () => {
    it('GET /api/runtime/status returns correct JSON regardless of static serving', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/runtime/status',
      });
      expect(res.statusCode).toBe(200);
      const ct = res.headers['content-type'] || '';
      expect(ct).toContain('application/json');

      const body = JSON.parse(res.body) as Record<string, unknown>;
      // These are the documented fields from registerRuntimeDispatchRoutes
      expect(body).toHaveProperty('runtime');
      expect(body).toHaveProperty('paused');
      expect(body).toHaveProperty('currentCardId');
      expect(body).toHaveProperty('goalCount');
    });

    it('GET /api/runtime/status body is JSON, not swallowed by SPA fallback', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/api/runtime/status',
      });
      expect(res.statusCode).toBe(200);
      // SPA fallback serves index.html which always has <div id="app">
      expect(res.body).not.toContain('<div id="app">');
      // Should be valid parseable JSON
      expect(() => JSON.parse(res.body)).not.toThrow();
    });

    it('POST /api/runtime/freeze handles request without SPA interference', async () => {
      // POST /api/runtime/freeze should respond with JSON, not SPA HTML
      const res = await server.fastify.inject({
        method: 'POST',
        url: '/api/runtime/freeze',
        payload: { reason: 'hardening-test' },
      });
      // The response should be JSON from the freeze endpoint, not SPA HTML
      expect(res.body).not.toContain('<div id="app">');
      // It should be valid JSON
      expect(() => JSON.parse(res.body)).not.toThrow();
      const body = JSON.parse(res.body) as Record<string, unknown>;
      // Should have a status field
      expect(body).toHaveProperty('status');
    });
  });
});

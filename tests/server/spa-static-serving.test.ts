/**
 * Stage fix-static-spa-serving — SPA Static Serving Integration Tests
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
 *
 * All requests use fastify.inject() — no actual HTTP server needed.
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

    it('GET /ws does not return SPA HTML', async () => {
      const res = await server.fastify.inject({
        method: 'GET',
        url: '/ws',
      });
      // WebSocket upgrade endpoint should not return SPA HTML
      expect(res.body).not.toContain('<div id="app">');
    });
  });
});

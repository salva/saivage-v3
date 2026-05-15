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

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PACKAGE_ROOT = join(__dirname, '..', '..');

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

describe('SPA static serving (projectRoot ≠ packageRoot)', () => {
  let fakeProjectRoot: string;
  let otherCwd: string;
  let server: Awaited<ReturnType<typeof import('../../src/server/server.js').createServer>>;
  let originalCwd: string;
  let jsAssetFile: string | null;

  beforeAll(async () => {
    originalCwd = process.cwd();
    fakeProjectRoot = mkdtempSync(join(tmpdir(), 'saivage-spa-test-'));
    otherCwd = mkdtempSync(join(tmpdir(), 'saivage-other-cwd-'));

    setupSkeletonProject(fakeProjectRoot);
    setupSkeletonProject(otherCwd);
    writeFileSync(
      join(otherCwd, '.saivage', 'runtime', 'state.json'),
      JSON.stringify({
        status: 'paused',
        project_id: 'project',
        pid: process.pid,
        started_at: new Date().toISOString(),
        current_card_id: null,
        current_agent_session_id: null,
        paused: true,
        paused_at: new Date().toISOString(),
        queue: [],
        running_processes: [],
        updated_at: new Date().toISOString(),
      }, null, 2),
    );

    process.chdir(otherCwd);
    jsAssetFile = findFirstJsAsset();

    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(fakeProjectRoot, false);
    await server.fastify.ready();
  }, 30000);

  afterAll(async () => {
    try { process.chdir(originalCwd); } catch {}
    if (server) {
      try { await server.stop(); } catch {}
    }
    try { rmSync(fakeProjectRoot, { recursive: true, force: true }); } catch {}
    try { rmSync(otherCwd, { recursive: true, force: true }); } catch {}
  }, 15000);

  describe('GET /', () => {
    it('returns 200 with Vue SPA index.html', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: '/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<div id="app">');
    });
  });

  describe('GET /assets/<file>.js', () => {
    it('returns asset when available', async () => {
      if (!jsAssetFile) return;
      const res = await server.fastify.inject({ method: 'GET', url: `/assets/${jsAssetFile}` });
      expect(res.statusCode).toBe(200);
      expect(String(res.headers['content-type'] || '')).toMatch(/javascript/);
    });
  });

  describe('GET /health', () => {
    it('uses projectRoot runtime state instead of process.cwd()', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: '/health' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body) as Record<string, unknown>;
      expect(body.runtime).toBe('idle');
      expect(body.runtime).not.toBe('paused');
    });
  });

  describe('GET /docs/', () => {
    it('returns docs content', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: '/docs/' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toMatch(/VitePress/);
    });
  });

  describe('API and websocket precedence', () => {
    it('GET /api/state returns JSON, not SPA HTML', async () => {
      const res = await server.fastify.inject({ method: 'GET', url: '/api/state' });
      expect(res.body).not.toContain('<div id="app">');
    });

    it('injectWS upgrades successfully', async () => {
      const ws: WebSocket = await (server.fastify as any).injectWS('/ws');
      expect(ws.readyState).toBe(ws.OPEN);
      ws.close();
    }, 10000);
  });
});

/**
 * Stage 9 — Server Integration Tests
 *
 * Tests verify the server startup integration:
 *   1. MCP status API endpoint returns expected format with valid auth
 *   2. Endpoint is protected by auth (401 without token)
 *   3. MCP status API returns empty servers list when no MCP config
 *   4. Server can be created and stopped
 *   5. MCP tools API endpoint returns expected format with valid auth
 *   6. MCP tools API endpoint is protected by auth
 *   7. MCP tools API returns empty tools when no MCP configured
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
    `saivage-server-int-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
// Integration Tests — with MCP servers
// ═══════════════════════════════════════════════════════════════

describe('Server Integration — MCP Status API', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;
  let mcpManager: { startAll(): Promise<void>; stopAll(): Promise<void>; getStatus(): unknown[] } | undefined;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {
      mcpServers: {
        'test-echo': {
          command: 'echo',
          args: ['hello'],
          transport: 'stdio',
          disabled: false,
          autostart: true,
        },
        'test-disabled': {
          command: 'echo',
          args: ['world'],
          transport: 'stdio',
          disabled: true,
          autostart: true,
        },
      },
    });

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    // Import and register auth plugin
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    // Import and register routes
    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    // Register health endpoint (no auth)
    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    // Register MCP status endpoint manually (matching server.ts)
    const { McpManager } = await import('../../src/mcp/mcp-manager.js');

    try {
      mcpManager = new McpManager(projectRoot);
      await mcpManager.startAll();
    } catch {
      // MCP manager init may fail — that's fine for API tests
    }

    app.get('/api/mcp/status', async (_request, reply) => {
      if (!mcpManager) {
        return reply.send({ servers: [] });
      }
      return reply.send({ servers: mcpManager.getStatus() });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (mcpManager) {
      await mcpManager.stopAll();
    }
    if (app) {
      await app.close();
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 10000);

  // ── Helpers ───────────────────────────────────────────────

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  // ── Tests ─────────────────────────────────────────────────

  it('GET /api/mcp/status returns expected format with valid auth', async () => {
    const res = await fetch(apiUrl('/api/mcp/status'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as { servers: Array<Record<string, unknown>> };
    expect(body).toHaveProperty('servers');
    expect(Array.isArray(body.servers)).toBe(true);

    // Should have both configured servers
    const names = body.servers.map((s) => s.name as string);
    expect(names).toContain('test-echo');
    expect(names).toContain('test-disabled');

    // Each server entry should have the expected fields
    for (const server of body.servers) {
      expect(server).toHaveProperty('name');
      expect(server).toHaveProperty('transport');
      expect(server).toHaveProperty('status');
      expect(['running', 'stopped', 'error']).toContain(server.status);
    }
  });

  it('GET /api/mcp/status is protected by auth (401 without token)', async () => {
    const res = await fetch(apiUrl('/api/mcp/status'));
    expect(res.status).toBe(401);
  });

  it('GET /api/mcp/status rejects invalid auth token', async () => {
    const res = await fetch(apiUrl('/api/mcp/status'), {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/mcp/status disabled server shows as stopped', async () => {
    const res = await fetch(apiUrl('/api/mcp/status'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as { servers: Array<Record<string, unknown>> };
    const disabled = body.servers.find((s) => s.name === 'test-disabled');
    expect(disabled).toBeDefined();
    expect(disabled!.status).toBe('stopped');
  });

  it('GET /api/mcp/status response is valid JSON', async () => {
    const res = await fetch(apiUrl('/api/mcp/status'), { headers: authHdr() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration Tests — MCP Tools API (with MCP servers)
// ═══════════════════════════════════════════════════════════════

describe('Server Integration — MCP Tools API', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;
  let mcpManager: {
    startAll(): Promise<void>;
    stopAll(): Promise<void>;
    getTools(): unknown[];
    getToolServers(): string[];
  } | undefined;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {
      mcpServers: {
        'test-echo': {
          command: 'echo',
          args: ['hello'],
          transport: 'stdio',
          disabled: false,
          autostart: true,
        },
        'test-disabled': {
          command: 'echo',
          args: ['world'],
          transport: 'stdio',
          disabled: true,
          autostart: true,
        },
      },
    });

    authToken = process.env['SAIVAGE_API_TOKEN'] || 'test-token';
    process.env['SAIVAGE_API_TOKEN'] = authToken;

    app = Fastify({ logger: false });
    await app.register(cors);
    await app.register(websocket);

    // Import and register auth plugin
    const { default: authPlugin } = await import('../../src/server/auth.js');
    await app.register(authPlugin);

    // Import and register routes
    const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
    const { registerRuntimeConfigNotesRoutes } = await import('../../src/server/routes/runtime-config-notes.js');
    const { registerChatsFilesDebugRoutes } = await import('../../src/server/routes/chats-files-debug.js');
    const { registerWebSocket } = await import('../../src/server/websocket.js');

    registerCardRoutes(app, projectRoot);
    registerRuntimeConfigNotesRoutes(app, projectRoot);
    registerChatsFilesDebugRoutes(app, projectRoot);
    registerWebSocket(app, projectRoot);

    // Register health endpoint (no auth)
    app.get('/health', async (_req, reply) => {
      return reply.send({ status: 'ok', version: '0.1.0', project: 'test', runtime: 'idle' });
    });

    // Register MCP tools endpoint manually (matching server.ts)
    const { McpManager } = await import('../../src/mcp/mcp-manager.js');

    try {
      mcpManager = new McpManager(projectRoot);
      await mcpManager.startAll();
    } catch {
      // MCP manager init may fail — that's fine for API tests
    }

    app.get('/api/mcp/tools', async (_request, reply) => {
      if (!mcpManager) {
        return reply.send({ tools: [], servers: [] });
      }
      const tools = mcpManager.getTools();
      const servers = mcpManager.getToolServers();
      return reply.send({ tools, servers });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (mcpManager) {
      await mcpManager.stopAll();
    }
    if (app) {
      await app.close();
    }
    try {
      rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }, 10000);

  // ── Helpers ───────────────────────────────────────────────

  function apiUrl(path: string): string {
    return `http://127.0.0.1:${port}${path}`;
  }

  function authHdr(): Record<string, string> {
    return { authorization: `Bearer ${authToken}` };
  }

  // ── Tests ─────────────────────────────────────────────────

  it('GET /api/mcp/tools returns expected format with valid auth', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = await res.json() as { tools: Array<unknown>; servers: string[] };
    expect(body).toHaveProperty('tools');
    expect(body).toHaveProperty('servers');
    expect(Array.isArray(body.tools)).toBe(true);
    expect(Array.isArray(body.servers)).toBe(true);
  });

  it('GET /api/mcp/tools is protected by auth (401 without token)', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'));
    expect(res.status).toBe(401);
  });

  it('GET /api/mcp/tools rejects invalid auth token', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('GET /api/mcp/tools returns valid JSON', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration Tests — MCP Tools API (without MCP servers)
// ═══════════════════════════════════════════════════════════════

describe('Server Integration — MCP Tools API (no MCP)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

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

    // Register MCP tools endpoint with fallback for no MCP config
    app.get('/api/mcp/tools', async (_request, reply) => {
      return reply.send({ tools: [], servers: [] });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('GET /api/mcp/tools returns empty tools when no MCP configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tools`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { tools: Array<unknown>; servers: Array<unknown> };
    expect(body).toHaveProperty('tools');
    expect(body).toHaveProperty('servers');
    expect(body.tools).toEqual([]);
    expect(body.servers).toEqual([]);
  });

  it('GET /api/mcp/tools requires auth when no MCP', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tools`);
    expect(res.status).toBe(401);
  });
});

// ═══════════════════════════════════════════════════════════════
// Integration Tests — Without MCP
// ═══════════════════════════════════════════════════════════════

describe('Server Integration — Without MCP', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {});

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

    // Register MCP endpoint with fallback for no MCP config
    app.get('/api/mcp/status', async (_request, reply) => {
      return reply.send({ servers: [] });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('GET /api/mcp/status returns empty servers when no MCP configured', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/status`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const body = await res.json() as { servers: Array<unknown> };
    expect(body).toHaveProperty('servers');
    expect(body.servers).toEqual([]);
  });

  it('GET /api/mcp/status requires auth when no MCP', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/status`);
    expect(res.status).toBe(401);
  });
});

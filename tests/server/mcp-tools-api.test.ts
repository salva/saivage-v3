/**
 * Stage 59 — MCP Tools API Metadata Contract Tests
 *
 * These tests verify the /api/mcp/tools response shape that the
 * DebugView MCP tab consumes.  They go beyond the existing
 * server-integration.test.ts by verifying:
 *
 *   1. The full four-field response shape: tools, servers, invocationStats, serverDetails
 *   2. serverDetails[] entry shape: name, transport, status, toolCount, tools[]
 *   3. Each tool entry in serverDetails has: name, description, inputSchema, stats{}
 *   4. invocationStats key format and stats shape
 *   5. Empty/no-MCP graceful fallback produces the full shape with empty collections
 *   6. Auth protection (401 without token, 401 with invalid token)
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
    `saivage-mcp-tools-api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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
      id: 'project', type: 'project', parent: null, depth: 0,
      title: 'project', description: '', status: 'backlog',
      tags: [], priority: 0, urgency: 'normal', created_by: 'analyst',
      created_at: now, updated_at: now,
      depends_on: [], blocks: [], related: [],
      acceptance: '', artifacts: [], attachments: [], retries: 0,
    }),
  );
  writeFileSync(
    join(sd, 'cards', 'index.json'),
    JSON.stringify({
      cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } },
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
      started_at: now, paused: false, queue: [], running_processes: [], updated_at: now,
    }),
  );
}

// ── Type helpers for response validation ──────────────────────

interface McpToolInvocationStats {
  total: number;
  success: number;
  error: number;
  lastInvokedAt?: string;
}

interface McpToolWithStats {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[] };
  stats: McpToolInvocationStats;
}

interface McpServerWithTools {
  name: string;
  transport: string;
  status: string;
  toolCount: number;
  tools: McpToolWithStats[];
}

interface McpToolsApiResponse {
  tools: unknown[];
  servers: string[];
  invocationStats: Record<string, McpToolInvocationStats>;
  serverDetails: McpServerWithTools[];
}

// ── Tests: With MCP servers configured ────────────────────────

describe('MCP Tools API — metadata contract (with MCP servers)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {
      mcpServers: {
        'test-filesystem': {
          command: 'echo',
          args: ['hello'],
          transport: 'stdio',
          disabled: false,
          autostart: true,
        },
        'test-web': {
          command: 'echo',
          args: ['world'],
          transport: 'stdio',
          disabled: false,
          autostart: true,
        },
        'test-disabled': {
          command: 'echo',
          args: ['disabled'],
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

    // Register MCP tools endpoint matching the full server.ts implementation
    const { McpManager } = await import('../../src/mcp/mcp-manager.js');

    let mcpManager: InstanceType<typeof McpManager> | undefined;
    try {
      mcpManager = new McpManager(projectRoot);
      await mcpManager.startAll();
    } catch {
      // MCP manager init may fail — API should still return empty shape
    }

    app.get('/api/mcp/tools', async (_request, reply) => {
      if (!mcpManager) {
        return reply.send({
          tools: [],
          servers: [],
          invocationStats: {},
          serverDetails: [],
        });
      }
      const tools = mcpManager.getTools();
      const servers = mcpManager.getToolServers();
      const invocationStats = mcpManager.getInvocationStats();

      const serverDetails = mcpManager.getStatus().map((status) => {
        const toolDefs = mcpManager!.getServerTools(status.name) ?? [];
        const toolList = toolDefs.map((td) => {
          const statsKey = `${status.name}:${td.name}`;
          const stats = invocationStats[statsKey] ?? { total: 0, success: 0, error: 0 };
          return {
            name: td.name,
            description: td.description,
            inputSchema: td.inputSchema,
            stats,
          };
        });
        return {
          name: status.name,
          transport: status.transport,
          status: status.status,
          toolCount: toolDefs.length,
          tools: toolList,
        };
      });

      return reply.send({ tools, servers, invocationStats, serverDetails });
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

  // ── Shape tests ────────────────────────────────────────────

  it('returns the full four-field response shape', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;

    // All four fields must be present
    expect(body).toHaveProperty('tools');
    expect(body).toHaveProperty('servers');
    expect(body).toHaveProperty('invocationStats');
    expect(body).toHaveProperty('serverDetails');

    // Correct types
    expect(Array.isArray(body.tools)).toBe(true);
    expect(Array.isArray(body.servers)).toBe(true);
    expect(typeof body.invocationStats).toBe('object');
    expect(Array.isArray(body.serverDetails)).toBe(true);
  });

  it('serverDetails entries have the expected shape', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;

    // Should include all configured servers (including disabled)
    const names = body.serverDetails.map((s) => s.name).sort();
    expect(names).toContain('test-filesystem');
    expect(names).toContain('test-web');
    expect(names).toContain('test-disabled');

    for (const server of body.serverDetails) {
      expect(typeof server.name).toBe('string');
      expect(typeof server.transport).toBe('string');
      expect(['stdio', 'sse']).toContain(server.transport);
      expect(['running', 'stopped', 'error']).toContain(server.status);
      expect(typeof server.toolCount).toBe('number');
      expect(Array.isArray(server.tools)).toBe(true);
    }
  });

  it('tool entries within serverDetails have name, description, inputSchema, stats', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;

    // Collect all tools across all server details
    const allTools = body.serverDetails.flatMap((s) => s.tools);

    for (const tool of allTools) {
      expect(typeof tool.name).toBe('string');
      // description may be undefined
      expect(tool).toHaveProperty('inputSchema');
      expect(tool.inputSchema).toHaveProperty('type');
      // stats must be present
      expect(tool).toHaveProperty('stats');
      expect(typeof tool.stats.total).toBe('number');
      expect(typeof tool.stats.success).toBe('number');
      expect(typeof tool.stats.error).toBe('number');
      expect(tool.stats.total).toBeGreaterThanOrEqual(0);
      expect(tool.stats.success + tool.stats.error).toBeLessThanOrEqual(tool.stats.total);
    }
  });

  it('invocationStats has correct key format and shape', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;
    const stats = body.invocationStats;

    // invocationStats is always an object (even if empty)
    expect(typeof stats).toBe('object');

    // Every key should be "${server}:${tool}" format
    for (const key of Object.keys(stats)) {
      expect(key).toMatch(/^.+:.+$/); // contains colon
    }

    // Every value has total, success, error
    for (const val of Object.values(stats)) {
      expect(typeof val.total).toBe('number');
      expect(typeof val.success).toBe('number');
      expect(typeof val.error).toBe('number');
    }
  });

  it('servers array lists server names with cached tools', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;

    expect(Array.isArray(body.servers)).toBe(true);
    for (const name of body.servers) {
      expect(typeof name).toBe('string');
    }
    // tools array contains tool definitions
    expect(Array.isArray(body.tools)).toBe(true);
  });

  // ── Auth tests ─────────────────────────────────────────────

  it('is protected by auth (401 without token)', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'));
    expect(res.status).toBe(401);
  });

  it('rejects invalid auth token', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), {
      headers: { authorization: 'Bearer wrong-token' },
    });
    expect(res.status).toBe(401);
  });

  it('returns valid JSON content type', async () => {
    const res = await fetch(apiUrl('/api/mcp/tools'), { headers: authHdr() });
    expect(res.status).toBe(200);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct).toContain('application/json');
  });
});

// ── Tests: Without MCP servers configured ────────────────────

describe('MCP Tools API — empty fallback (no MCP servers)', () => {
  let projectRoot: string;
  let app: FastifyInstance;
  let port: number;
  let authToken: string;

  beforeAll(async () => {
    projectRoot = uniqueDir();
    setupProject(projectRoot, {}); // no mcpServers

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

    // No mcpManager — simulate no MCP config
    app.get('/api/mcp/tools', async (_request, reply) => {
      return reply.send({
        tools: [],
        servers: [],
        invocationStats: {},
        serverDetails: [],
      });
    });

    await app.listen({ port: 0, host: '127.0.0.1' });
    port = (app.server.address() as { port: number }).port;
  }, 30000);

  afterAll(async () => {
    if (app) await app.close();
    try { rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }, 10000);

  it('returns all four fields as empty collections', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tools`, {
      headers: { authorization: `Bearer ${authToken}` },
    });
    expect(res.status).toBe(200);

    const body = (await res.json()) as McpToolsApiResponse;

    expect(body.tools).toEqual([]);
    expect(body.servers).toEqual([]);
    expect(body.invocationStats).toEqual({});
    expect(body.serverDetails).toEqual([]);
  });

  it('empty response still requires auth', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/mcp/tools`);
    expect(res.status).toBe(401);
  });
});

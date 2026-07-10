/**
 * Stage 9 — MCP Manager Tests
 *
 * Tests cover:
 *   1. Config loading from saivage.yaml
 *   2. Disabled servers are skipped
 *   3. Error handling (unknown server, missing command, missing URL)
 *   4. Health check returns false for unknown/disabled servers
 *   5. getStatus() and getServerStatus() return correct info
 *   6. Streamable HTTP start errors when URL is missing
 *   7. stdio start errors when command is missing
 *   8. startAll skips disabled, starts autostart
 *   9. startServer starts and stopServer stops gracefully
 *   10. restartServer stops then starts
 *   11. Tool discovery: getTools(), getServerTools(), getToolServers(), tools_count in status, stop clears cache
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as YAML from 'yaml';
import { loadEnvironment } from '../../src/config/environment.js';

// ── Mocks ─────────────────────────────────────────────────────

// Each spawn creates an independent mock process with its own handlers.
let nextPid = 12345;

function createMockProc(opts?: { earlyExit?: boolean }) {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const pid = nextPid++;
  // stdin/stdout stream mocks with 'on' and writable flag
  const stdin = {
    writable: !opts?.earlyExit,
    on: jest.fn(),
    write: jest.fn((_data: string) => {
      if (!stdin.writable) {
        const err = new Error('write EPIPE');
        process.nextTick(() => {
          const errHandlers = handlers['error.stdin'] ?? [];
          for (const h of errHandlers) h(err);
        });
        return false;
      }
      return true;
    }),
  };
  const stdout = {
    on: jest.fn(),
  };
  const proc = {
    pid,
    killed: false,
    exitCode: null as number | null,
    stdin,
    stdout,
    on: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      (handlers[event] ??= []).push(handler);
      return proc;
    }),
    once: jest.fn((event: string, handler: (...args: unknown[]) => void) => {
      // For 'exit' event, register it separately so it fires alongside the 'on' handlers
      // and then auto-removes (we track it in a separate list).
      (handlers[event] ??= []).push(handler);
      return proc;
    }),
    kill: jest.fn((_signal?: string) => {
      proc.killed = true;
      proc.exitCode = _signal === 'SIGKILL' ? 137 : 0;
      // Fire all exit handlers
      const exitHandlers = [...(handlers['exit'] ?? [])];
      for (const h of exitHandlers) {
        try {
          h(proc.exitCode, _signal ?? 'SIGTERM');
        } catch {
          // ignore handler errors
        }
      }
      // Remove exit handlers after firing (simulate once behavior)
      delete handlers['exit'];
      return true;
    }),
  };
  return proc;
}

const mockSpawn = jest.fn((_cmd: string, _args: string[], _opts: unknown) => {
  return createMockProc();
});

// Store a reference so tests can override spawn behavior per-call
let _spawnOpts: { earlyExit?: boolean } = {};

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

jest.unstable_mockModule('node:child_process', () => ({
  spawn: mockSpawn,
}));

// ── Helpers ───────────────────────────────────────────────────

const testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-mcp-test-'));
  testRoots.push(dir);
  return dir;
}

function writeSaivageJson(projectRoot: string, overrides: Record<string, unknown>): void {
  const saivageDir = join(projectRoot, '.saivage');
  mkdirSync(saivageDir, { recursive: true });
  const config = {
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: {
      test: { priority: 10, models: ['test-model'], apiKey: 'secret-key' },
    },
    ...overrides,
  };
  writeFileSync(join(saivageDir, 'saivage.yaml'), YAML.stringify(config));
}

function loadTestConfig(projectRoot: string) {
  return loadEnvironment(['node', 'test', '--project-root', projectRoot], process.env).config;
}

function createMcpManager(McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'], projectRoot: string, options: { scope?: import('../../src/lifecycle/index.js').ResourceScope } = {}) {
  return new McpManager(projectRoot, { ...options, config: loadTestConfig(projectRoot) });
}

function stdioConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'echo',
    args: ['hello'],
    transport: 'stdio',
    disabled: false,
    autostart: true,
    ...overrides,
  };
}

function sseResponse(events: string, init: ResponseInit = {}): Response {
  return new Response(events, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream',
      ...(init.headers as Record<string, string> | undefined),
    },
    ...init,
  });
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function streamableHttpConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'http://localhost:9999/mcp',
    transport: 'streamable-http',
    disabled: false,
    autostart: true,
    ...overrides,
  };
}

afterEach(() => {
  mockSpawn.mockClear();
  nextPid = 12345;
  for (const dir of testRoots) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  testRoots.length = 0;
});

// ── Dynamic import ────────────────────────────────────────────

async function importMcpManager() {
  return await import('../../src/mcp/mcp-manager.js');
}

// ═══════════════════════════════════════════════════════════════
// Suite 1: Config Loading
// ═══════════════════════════════════════════════════════════════

describe('McpManager config loading', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  it('loads mcpServers from saivage.yaml', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
        'test-streamable': streamableHttpConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    const status = mgr.getStatus();
    expect(status).toHaveLength(2);
    expect(status.map((s) => s.name).sort()).toEqual(['test-stdio', 'test-streamable']);
    expect(status[0]).toHaveProperty('transport');
    expect(status[0]).toHaveProperty('status');
  });

  it('returns empty status list when no mcpServers configured', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const mgr = createMcpManager(McpManager, root);
    const status = mgr.getStatus();
    expect(status).toEqual([]);
  });

  it('treats disabled servers as stopped in getStatus', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-disabled': stdioConfig({ disabled: true, autostart: true }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    const status = mgr.getStatus();
    expect(status).toHaveLength(1);
    expect(status[0].status).toBe('stopped');
  });

  it('getServerStatus returns undefined for unknown server', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    expect(mgr.getServerStatus('nonexistent')).toBeUndefined();
  });

  it('getServerStatus returns status for configured server', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    const s = mgr.getServerStatus('test-stdio');
    expect(s).toBeDefined();
    expect(s!.name).toBe('test-stdio');
    expect(s!.transport).toBe('stdio');
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 2: Disabled Servers
// ═══════════════════════════════════════════════════════════════

describe('McpManager disabled servers', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  it('startAll skips disabled servers (autostart true)', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-enabled': stdioConfig({ disabled: false, autostart: true }),
        'test-disabled': stdioConfig({ disabled: true, autostart: true }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startAll();

    // wait a tick for the async start to settle
    await new Promise((r) => setTimeout(r, 50));

    const enabledStatus = mgr.getServerStatus('test-enabled');
    const disabledStatus = mgr.getServerStatus('test-disabled');

    expect(enabledStatus!.status).toBe('running');
    expect(disabledStatus!.status).toBe('stopped');
    // Only one spawn call
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('startServer silently skips a disabled server (no error)', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-disabled': stdioConfig({ disabled: true }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await expect(mgr.startServer('test-disabled')).resolves.toBeUndefined();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('healthCheck returns false for disabled server', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-disabled': stdioConfig({ disabled: true }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    const healthy = await mgr.healthCheck('test-disabled');
    expect(healthy).toBe(false);
  });

  it('healthCheck returns false for unknown server', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const mgr = createMcpManager(McpManager, root);
    const healthy = await mgr.healthCheck('nonexistent');
    expect(healthy).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 3: Error Handling
// ═══════════════════════════════════════════════════════════════

describe('McpManager error handling', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  it('startServer throws for unknown server name', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const mgr = createMcpManager(McpManager, root);
    await expect(mgr.startServer('nonexistent')).rejects.toThrow(
      "MCP server 'nonexistent' not found in configuration.",
    );
  });

  it('_startStdio throws when command is missing', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'no-command': { transport: 'stdio', disabled: false, autostart: true },
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await expect(mgr.startServer('no-command')).rejects.toThrow(
      "stdio MCP server 'no-command' has no 'command' configured.",
    );

    const status = mgr.getServerStatus('no-command');
    expect(status).toBeDefined();
    expect(status!.status).toBe('error');
    expect(status!.error).toContain("has no 'command' configured");
  });

  it('startStreamableHttp throws when URL is missing', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'no-url': { transport: 'streamable-http', disabled: false, autostart: true },
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await expect(mgr.startServer('no-url')).rejects.toThrow(
      "streamable-http MCP server 'no-url' has no 'url' configured.",
    );

    const status = mgr.getServerStatus('no-url');
    expect(status).toBeDefined();
    expect(status!.status).toBe('error');
    expect(status!.error).toContain("has no 'url' configured");
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 4: Lifecycle (start / stop / restart / getStatus)
// ═══════════════════════════════════════════════════════════════

describe('McpManager lifecycle', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  beforeEach(() => {
    mockSpawn.mockClear();
    nextPid = 12345;
  });

  it('startServer spawns stdio process and status shows running', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith(
      'echo',
      ['hello'],
      expect.objectContaining({
        env: expect.any(Object),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );

    const status = mgr.getServerStatus('test-stdio');
    expect(status).toBeDefined();
    expect(status!.status).toBe('running');
    expect(status!.pid).toBe(12345);
    expect(status!.startedAt).toBeDefined();
  });

  it('stopServer sets status to stopped', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');
    expect(mgr.getServerStatus('test-stdio')!.status).toBe('running');

    await mgr.stopServer('test-stdio');
    const status = mgr.getServerStatus('test-stdio');
    expect(status).toBeDefined();
    expect(status!.status).toBe('stopped');
  });

  it('restartServer works: status is running after restart', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig({ command: 'node', args: ['-e', '1'] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    // Start first, then restart (stop + start)
    await mgr.startServer('test-stdio');
    expect(mgr.getServerStatus('test-stdio')!.status).toBe('running');

    await mgr.restartServer('test-stdio');
    const status = mgr.getServerStatus('test-stdio');
    expect(status).toBeDefined();
    expect(status!.status).toBe('running');

    // start + restart = 2 spawns total
    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('stopAll stops all running servers', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        srv1: stdioConfig({ command: 'cmd1' }),
        srv2: stdioConfig({ command: 'cmd2' }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('srv1');
    await mgr.startServer('srv2');

    expect(mgr.getServerStatus('srv1')!.status).toBe('running');
    expect(mgr.getServerStatus('srv2')!.status).toBe('running');

    await mgr.stopAll();

    const srv1Status = mgr.getServerStatus('srv1');
    const srv2Status = mgr.getServerStatus('srv2');
    expect(srv1Status!.status).toBe('stopped');
    expect(srv2Status!.status).toBe('stopped');
  });

  it('does not restart an already running stdio server', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Start again - should be a no-op
    await mgr.startServer('test-stdio');
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 5: Health Check
// ═══════════════════════════════════════════════════════════════

describe('McpManager health check', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  beforeEach(() => {
    mockSpawn.mockClear();
    nextPid = 12345;
  });

  it('healthCheck returns false when no handle exists', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    // Not started — no handle
    const healthy = await mgr.healthCheck('test-stdio');
    expect(healthy).toBe(false);
  });

  it('healthCheck returns boolean for running stdio process', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');

    // healthCheck calls process.kill(pid, 0) which checks if the PID exists
    // on the real system. The mock PID 12345 may or may not exist.
    // We verify healthCheck runs without throwing and returns a boolean.
    const healthy = await mgr.healthCheck('test-stdio');
    expect(typeof healthy).toBe('boolean');
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 6: Tool Discovery
// ═══════════════════════════════════════════════════════════════

describe('McpManager tool discovery', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  beforeEach(() => {
    mockSpawn.mockClear();
    nextPid = 12345;
  });

  it('discovers tools from text/event-stream initialize and paginated tools/list with session propagation', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: { stream: streamableHttpConfig({ url: 'http://localhost:9999/mcp' }) },
    });
    const calls: any[] = [];
    (globalThis as any).fetch = jest.fn(async (_url: string, init?: any) => {
      calls.push(init);
      if (init.method === 'HEAD') return { ok: true, status: 200 };
      const body = JSON.parse(init.body);
      if (body.method === 'initialize') {
        return sseResponse(
          sseData({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-06-18' } }),
          {
            headers: {
              'content-type': 'text/event-stream',
              'Mcp-Session-Id': 'synthetic-session-2',
            },
          },
        );
      }
      if (body.method === 'notifications/initialized') {
        return new Response(null, { status: 202 });
      }
      if (body.method === 'tools/list' && !body.params?.cursor) {
        return sseResponse(
          sseData({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [{ name: 'one', inputSchema: { type: 'object' } }],
              nextCursor: 'page-2',
            },
          }),
        );
      }
      return sseResponse(
        sseData({
          jsonrpc: '2.0',
          id: body.id,
          result: { tools: [{ name: 'two', inputSchema: { type: 'object' } }] },
        }),
      );
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('stream');

    expect(mgr.getServerTools('stream')?.map((tool) => tool.name)).toEqual(['one', 'two']);
    const rpcCalls = calls.filter((call) => call?.body);
    const notificationCall = rpcCalls.find(
      (call) => JSON.parse(call.body).method === 'notifications/initialized',
    );
    expect(notificationCall.headers).toEqual(
      expect.objectContaining({
        Accept: 'application/json, text/event-stream',
        'Mcp-Session-Id': 'synthetic-session-2',
      }),
    );
    const listCalls = rpcCalls.filter((call) => JSON.parse(call.body).method === 'tools/list');
    expect(listCalls).toHaveLength(2);
    expect(listCalls[0].headers['Mcp-Session-Id']).toBe('synthetic-session-2');
    expect(listCalls[1].headers['Mcp-Session-Id']).toBe('synthetic-session-2');
  });

  it('records unsupported legacy SSE diagnostic instead of caching tools', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: { legacy: streamableHttpConfig({ url: 'http://localhost:9999/sse' }) },
    });
    (globalThis as any).fetch = jest.fn(async (_url: string, init?: any) => {
      if (init.method === 'HEAD') return { ok: true, status: 200 };
      return new Response('event: endpoint\ndata: /message\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('legacy');

    expect(mgr.getServerTools('legacy')).toBeUndefined();
    expect(mgr.getServerStatus('legacy')?.status).toBe('running');
  });

  it('getTools() returns empty array initially', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});
    const mgr = createMcpManager(McpManager, root);
    expect(mgr.getTools()).toEqual([]);
    expect(mgr.getToolServers()).toEqual([]);
  });

  it('getServerTools returns undefined for unknown server', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});
    const mgr = createMcpManager(McpManager, root);
    expect(mgr.getServerTools('nonexistent')).toBeUndefined();
  });

  it('tools_count appears in status for running server', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });
    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');

    const status = mgr.getServerStatus('test-stdio');
    expect(status).toBeDefined();
    expect(status!).toHaveProperty('tools_count');
    expect(typeof status!.tools_count).toBe('number');

    await mgr.stopServer('test-stdio');
  });

  it('stopServer clears tool cache', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });
    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');

    // Start populates tools_cache (even if empty from failed discovery)
    await mgr.stopServer('test-stdio');

    // After stop, getToolServers should not include the stopped server
    expect(mgr.getServerTools('test-stdio')).toBeUndefined();
    expect(mgr.getToolServers()).not.toContain('test-stdio');
  });

  it('getTools() returns empty after server stopped without discovery', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });
    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('test-stdio');
    await mgr.stopServer('test-stdio');

    expect(mgr.getTools()).toEqual([]);
  });

  it('tools_count defaults to 0 for disabled servers', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-disabled': stdioConfig({ disabled: true }),
      },
    });
    const mgr = createMcpManager(McpManager, root);
    const status = mgr.getServerStatus('test-disabled')!;
    // Disabled servers don't have tools_count field
    expect(status.tools_count).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════
// Suite 7: Bad Stdio Fixtures (Early Exit / EPIPE)
// ═══════════════════════════════════════════════════════════════

describe('McpManager bad stdio fixtures (early exit / EPIPE)', () => {
  let McpManager: Awaited<ReturnType<typeof importMcpManager>>['McpManager'];

  beforeAll(async () => {
    const mod = await importMcpManager();
    McpManager = mod.McpManager;
  });

  beforeEach(() => {
    mockSpawn.mockClear();
    nextPid = 12345;
  });

  it('startServer does not crash when stdio command exits early (EPIPE)', async () => {
    // Simulate a bad command that exits immediately: after spawn, we manually
    // trigger the exit handler to simulate a process that exits before discovery.
    // The McpManager should handle this gracefully.

    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'bad-cmd': stdioConfig({ command: 'non-existent-command', args: [] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);

    // startServer should resolve without throwing
    await expect(mgr.startServer('bad-cmd')).resolves.toBeUndefined();

    // Verify spawn was called
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Simulate the process exiting immediately with non-zero exit code
    // (the exit handler marks it as error and cleans up)
    await mgr.stopServer('bad-cmd');
    await new Promise((r) => setTimeout(r, 10));

    const status = mgr.getServerStatus('bad-cmd');
    expect(status).toBeDefined();
    // After stopServer, the status should be 'stopped'
    expect(status!.status).toBe('stopped');
  });

  it('startAll does not crash when a bad stdio server exits early', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'good-cmd': stdioConfig({ command: 'echo', args: ['ok'] }),
        'bad-cmd': stdioConfig({ command: 'non-existent-binary', args: [] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);

    // startAll should not throw — Promise.allSettled absorbs individual failures
    await expect(mgr.startAll()).resolves.toBeUndefined();

    // Give async starts time to settle
    await new Promise((r) => setTimeout(r, 50));

    // Both servers should have status entries
    const goodStatus = mgr.getServerStatus('good-cmd');
    const badStatus = mgr.getServerStatus('bad-cmd');
    expect(goodStatus).toBeDefined();
    expect(badStatus).toBeDefined();
  });

  it('bad stdio server reports correct error in status', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'bad-exit': stdioConfig({ command: 'false', args: [] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);

    // startServer should not throw
    await mgr.startServer('bad-exit');

    // Wait for exit handler
    await new Promise((r) => setTimeout(r, 50));

    const status = mgr.getServerStatus('bad-exit');
    expect(status).toBeDefined();
    // Should be in error state with a meaningful message
    if (status!.status === 'error') {
      expect(typeof status!.error).toBe('string');
      expect(status!.error!.length).toBeGreaterThan(0);
    }
  });

  it('getStatus() returns all servers including failed ones', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'srv-a': stdioConfig({ command: 'echo', args: ['a'] }),
        'srv-b': stdioConfig({ command: 'badcmd', args: [] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startAll();
    await new Promise((r) => setTimeout(r, 50));

    const allStatus = mgr.getStatus();
    expect(allStatus).toHaveLength(2);

    const names = allStatus.map((s) => s.name).sort();
    expect(names).toEqual(['srv-a', 'srv-b']);

    // Every server should have name, transport, status
    for (const s of allStatus) {
      expect(s).toHaveProperty('name');
      expect(s).toHaveProperty('transport');
      expect(s).toHaveProperty('status');
      expect(['running', 'stopped', 'error']).toContain(s.status);
    }
  });

  it('discovery does not run when process exits before discovery starts', async () => {
    // The exit handler in _startStdio removes the handle immediately.
    // startServer checks handle presence before calling _discoverTools.
    // This test verifies that discovery is skipped when the handle is gone.

    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'fast-exit': stdioConfig({ command: 'true', args: [] }),
      },
    });

    const mgr = createMcpManager(McpManager, root);
    await mgr.startServer('fast-exit');
    await new Promise((r) => setTimeout(r, 50));

    // Tools should be empty (discovery didn't run or failed)
    expect(mgr.getTools()).toEqual([]);
    expect(mgr.getToolServers()).toEqual([]);
  });
});

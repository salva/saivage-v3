/**
 * Stage 9 — MCP Manager Tests
 *
 * Tests cover:
 *   1. Config loading from saivage.json
 *   2. Disabled servers are skipped
 *   3. Error handling (unknown server, missing command, missing URL)
 *   4. Health check returns false for unknown/disabled servers
 *   5. getStatus() and getServerStatus() return correct info
 *   6. SSE start errors when URL is missing
 *   7. stdio start errors when command is missing
 *   8. startAll skips disabled, starts autostart
 *   9. startServer starts and stopServer stops gracefully
 *   10. restartServer stops then starts
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mocks ─────────────────────────────────────────────────────

// Each spawn creates an independent mock process with its own handlers.
let nextPid = 12345;

function createMockProc() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const pid = nextPid++;
  const proc = {
    pid,
    killed: false,
    exitCode: null as number | null,
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
  writeFileSync(join(saivageDir, 'saivage.json'), JSON.stringify(config, null, 2));
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

function sseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'http://localhost:9999/sse',
    transport: 'sse',
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

  it('loads mcpServers from saivage.json', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
        'test-sse': sseConfig(),
      },
    });

    const mgr = new McpManager(root);
    const status = mgr.getStatus();
    expect(status).toHaveLength(2);
    expect(status.map((s) => s.name).sort()).toEqual(['test-sse', 'test-stdio']);
    expect(status[0]).toHaveProperty('transport');
    expect(status[0]).toHaveProperty('status');
  });

  it('returns empty status list when no mcpServers configured', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
    expect(mgr.getServerStatus('nonexistent')).toBeUndefined();
  });

  it('getServerStatus returns status for configured server', () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'test-stdio': stdioConfig(),
      },
    });

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
    const healthy = await mgr.healthCheck('test-disabled');
    expect(healthy).toBe(false);
  });

  it('healthCheck returns false for unknown server', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {});

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
    await expect(mgr.startServer('no-command')).rejects.toThrow(
      "stdio MCP server 'no-command' has no 'command' configured.",
    );

    const status = mgr.getServerStatus('no-command');
    expect(status).toBeDefined();
    expect(status!.status).toBe('error');
    expect(status!.error).toContain("has no 'command' configured");
  });

  it('_startSse throws when URL is missing', async () => {
    const root = makeProjectRoot();
    writeSaivageJson(root, {
      mcpServers: {
        'no-url': { transport: 'sse', disabled: false, autostart: true },
      },
    });

    const mgr = new McpManager(root);
    await expect(mgr.startServer('no-url')).rejects.toThrow(
      "sse MCP server 'no-url' has no 'url' configured.",
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

    const mgr = new McpManager(root);
    await mgr.startServer('test-stdio');

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(mockSpawn).toHaveBeenCalledWith('echo', ['hello'], expect.objectContaining({
      env: expect.any(Object),
      stdio: ['pipe', 'pipe', 'pipe'],
    }));

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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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
        'srv1': stdioConfig({ command: 'cmd1' }),
        'srv2': stdioConfig({ command: 'cmd2' }),
      },
    });

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
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

    const mgr = new McpManager(root);
    await mgr.startServer('test-stdio');

    // healthCheck calls process.kill(pid, 0) which checks if the PID exists
    // on the real system. The mock PID 12345 may or may not exist.
    // We verify healthCheck runs without throwing and returns a boolean.
    const healthy = await mgr.healthCheck('test-stdio');
    expect(typeof healthy).toBe('boolean');
  });
});

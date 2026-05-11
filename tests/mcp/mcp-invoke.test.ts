/**
 * Stage 35 — MCP Tool Invocation Tests
 *
 * Tests: error types, invokeTool validation, stdio transport,
 * SSE transport, invocation stats, event logging, AgentAdapter + ContentSupervisor.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, jest } from '@jest/globals';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn as realSpawn } from 'node:child_process';

// ── Mocks ─────────────────────────────────────────────────────

let nextPid = 12345;

function createMockProc() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const pid = nextPid++;
  const proc: Record<string, unknown> = {
    pid, killed: false, exitCode: null as number | null,
    stdin: null, stdout: null,
    on: jest.fn((e: string, h: (...args: unknown[]) => void) => {
      (handlers[e] ??= []).push(h); return proc;
    }),
    once: jest.fn((e: string, h: (...args: unknown[]) => void) => {
      (handlers[e] ??= []).push(h); return proc;
    }),
    kill: jest.fn((sig?: string) => {
      proc.killed = true;
      proc.exitCode = sig === 'SIGKILL' ? 137 : 0;
      for (const h of [...(handlers['exit'] ?? [])]) {
        try { h(proc.exitCode, sig ?? 'SIGTERM'); } catch { /* ok */ }
      }
      delete handlers['exit'];
      return true;
    }),
  };
  return proc;
}

const mockSpawn = jest.fn(() => createMockProc());

jest.unstable_mockModule('node:child_process', () => ({ spawn: mockSpawn }));

// ── Helpers ───────────────────────────────────────────────────

const testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-mcp-invoke-test-'));
  testRoots.push(dir);
  return dir;
}

function writeSaivageJson(root: string, overrides: Record<string, unknown>): void {
  const sd = join(root, '.saivage');
  mkdirSync(sd, { recursive: true });
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({
    server: { port: 8080, host: '127.0.0.1' },
    models: { default: ['test-model'] },
    providers: { test: { priority: 10, models: ['test-model'], apiKey: 'sk' } },
    ...overrides,
  }, null, 2));
}

function stdioCfg(overrides: Record<string, unknown> = {}) {
  return { command: 'echo', args: ['hello'], transport: 'stdio', disabled: false, autostart: true, ...overrides };
}

function sseCfg(overrides: Record<string, unknown> = {}) {
  return { url: 'http://localhost:9999/sse', transport: 'sse', disabled: false, autostart: true, ...overrides };
}

function mcpScript(opts?: { alwaysIsError?: boolean; hangOnCall?: boolean; errorCode?: number }): string {
  const isErr = opts?.alwaysIsError ?? false;
  const hang = opts?.hangOnCall ?? false;
  const errCode = opts?.errorCode ?? -32602;
  const callHandler = hang ? '/* hang: no response */' : `
    if (${isErr}) {
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[], isError:true } }) + '\\n');
    } else if (req.method === 'tools/call') {
      const n = req.params && req.params.name;
      if (${errCode} !== -32602) {
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, error:{ code:${errCode}, message:'Custom error for '+n } }) + '\\n');
      } else if (n === 'greet') {
        const name = (req.params.arguments && req.params.arguments.name) || 'unknown';
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{type:'text',text:'Hello '+name}] } }) + '\\n');
      } else if (n === 'add') {
        const a = (req.params.arguments && req.params.arguments.a) || 0;
        const b = (req.params.arguments && req.params.arguments.b) || 0;
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{type:'text',text:String(a+b)}] } }) + '\\n');
      } else {
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, error:{ code:-32602, message:'Unknown: '+n } }) + '\\n');
      }
    }`;
  return `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ protocolVersion:'2025-06-18', capabilities:{}, serverInfo:{ name:'test', version:'1.0' } } }) + '\\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ tools:[ {name:'greet',description:'Hi',inputSchema:{type:'object',properties:{name:{type:'string'}}}}, {name:'add',description:'Add',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}}}} ] } }) + '\\n');
  }
  ${callHandler}
});
`;
}

/**
 * Spawn a real Node process running the MCP server script,
 * set up the handle manually, and inject tools.
 * Uses realSpawn (imported before mocking) to bypass the jest mock.
 */
async function setupRealProc(mgr: unknown, serverName: string, root: string, script: string, toolDefs: unknown[]) {
  const m = mgr as Record<string, unknown>;
  const sp = join(root, 'mcp-' + serverName + '.js');
  writeFileSync(sp, script);
  const proc = realSpawn('node', [sp], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise(r => setTimeout(r, 150));

  (m.handles as Map<string, unknown>).set(serverName, { process: proc });
  (m.toolsCache as Map<string, unknown[]>).set(serverName, toolDefs);
  (m.toolsCacheInitialized as Set<string>).add(serverName);
  (m.startedAt as Map<string, string>).set(serverName, new Date().toISOString());
  return proc;
}

afterEach(() => {
  mockSpawn.mockClear();
  nextPid = 12345;
  for (const d of testRoots) try { rmSync(d, { recursive: true, force: true }); } catch { /* ok */ }
  testRoots.length = 0;
});

async function impMcp() { return await import('../../src/mcp/mcp-manager.js'); }

// ═══════════════════ Suite 1: Error Types ════════════════════

describe('Error Types', () => {
  let McpInvokeError: any, ServerNotRunningError: any, ToolNotFoundError: any;
  let InvalidArgumentsError: any, TimeoutError: any, TransportError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpInvokeError = m.McpInvokeError;
    ServerNotRunningError = m.ServerNotRunningError;
    ToolNotFoundError = m.ToolNotFoundError;
    InvalidArgumentsError = m.InvalidArgumentsError;
    TimeoutError = m.TimeoutError;
    TransportError = m.TransportError;
  });

  it('McpInvokeError base has code and statusCode', () => {
    const e = new McpInvokeError('msg', 'CODE', 418);
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('CODE');
    expect(e.statusCode).toBe(418);
    expect(e.message).toBe('msg');
    expect(e.name).toBe('McpInvokeError');
  });

  it('ServerNotRunningError code=SERVER_NOT_RUNNING statusCode=404', () => {
    const e = new ServerNotRunningError('srv');
    expect(e.code).toBe('SERVER_NOT_RUNNING');
    expect(e.statusCode).toBe(404);
    expect(e.message).toContain("'srv'");
    expect(e.name).toBe('ServerNotRunningError');
    expect(e instanceof McpInvokeError).toBe(true);
  });

  it('ToolNotFoundError code=TOOL_NOT_FOUND statusCode=404', () => {
    const e = new ToolNotFoundError('srv', 'tool');
    expect(e.code).toBe('TOOL_NOT_FOUND');
    expect(e.statusCode).toBe(404);
    expect(e.name).toBe('ToolNotFoundError');
    expect(e instanceof McpInvokeError).toBe(true);
  });

  it('InvalidArgumentsError code=INVALID_ARGUMENTS statusCode=400', () => {
    const e = new InvalidArgumentsError('srv', 'tool', { f: 'x' });
    expect(e.code).toBe('INVALID_ARGUMENTS');
    expect(e.statusCode).toBe(400);
    expect(e.data).toEqual({ f: 'x' });
    expect(e.name).toBe('InvalidArgumentsError');
    expect(e instanceof McpInvokeError).toBe(true);
  });

  it('InvalidArgumentsError works without data', () => {
    const e = new InvalidArgumentsError('srv', 'tool');
    expect(e.code).toBe('INVALID_ARGUMENTS');
    expect(e.data).toBeUndefined();
  });

  it('TimeoutError code=TIMEOUT statusCode=408', () => {
    const e = new TimeoutError('srv', 'tool', 30000);
    expect(e.code).toBe('TIMEOUT');
    expect(e.statusCode).toBe(408);
    expect(e.message).toContain('30000ms');
    expect(e.name).toBe('TimeoutError');
    expect(e instanceof McpInvokeError).toBe(true);
  });

  it('TransportError code=TRANSPORT_ERROR statusCode=502', () => {
    const e = new TransportError('srv', 'boom');
    expect(e.code).toBe('TRANSPORT_ERROR');
    expect(e.statusCode).toBe(502);
    expect(e.message).toContain('boom');
    expect(e.name).toBe('TransportError');
    expect(e instanceof McpInvokeError).toBe(true);
  });

  it('instanceof checks work correctly', () => {
    const a = new ServerNotRunningError('s');
    const b = new ToolNotFoundError('s', 't');
    const c = new InvalidArgumentsError('s', 't');
    const d = new TimeoutError('s', 't', 5000);
    const e = new TransportError('s', 'd');
    expect(a instanceof McpInvokeError).toBe(true);
    expect(b instanceof McpInvokeError).toBe(true);
    expect(c instanceof McpInvokeError).toBe(true);
    expect(d instanceof McpInvokeError).toBe(true);
    expect(e instanceof McpInvokeError).toBe(true);
    expect(a instanceof ToolNotFoundError).toBe(false);
    expect(b instanceof ServerNotRunningError).toBe(false);
  });
});

// ═══════════════════ Suite 2: invokeTool Validation ══════════

describe('invokeTool validation', () => {
  let McpManager: any, ServerNotRunningError: any, ToolNotFoundError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpManager = m.McpManager;
    ServerNotRunningError = m.ServerNotRunningError;
    ToolNotFoundError = m.ToolNotFoundError;
  });

  it('throws ServerNotRunningError for unknown server name', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {});
    const mgr = new McpManager(r);
    await expect(mgr.invokeTool('nope', 'greet', {})).rejects.toThrow(ServerNotRunningError);
  });

  it('throws ServerNotRunningError when server is not started', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'test': stdioCfg() } });
    const mgr = new McpManager(r);
    await expect(mgr.invokeTool('test', 'greet', {})).rejects.toThrow(ServerNotRunningError);
  });

  it('throws ToolNotFoundError when tool not in cache', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'test': stdioCfg() } });
    const mgr = new McpManager(r);
    await mgr.startServer('test');
    await expect(mgr.invokeTool('test', 'no-such-tool', {})).rejects.toThrow(ToolNotFoundError);
  });

  it('throws ToolNotFoundError for tool in different server cache', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { srv1: stdioCfg({ command: 'c1' }), srv2: stdioCfg({ command: 'c2' }) } });
    const mgr = new McpManager(r);
    await mgr.startServer('srv1');
    await mgr.startServer('srv2');
    await expect(mgr.invokeTool('srv1', 'anything', {})).rejects.toThrow(ToolNotFoundError);
  });
});

// ═══════════════════ Suite 3: invokeTool stdio ═══════════════

describe('invokeTool stdio transport', () => {
  let McpManager: any, InvalidArgumentsError: any, McpInvokeError: any;
  let TimeoutError: any, TransportError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpManager = m.McpManager;
    InvalidArgumentsError = m.InvalidArgumentsError;
    McpInvokeError = m.McpInvokeError;
    TimeoutError = m.TimeoutError;
    TransportError = m.TransportError;
  });

  const stdioTools = [
    { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } },
    { name: 'add', description: 'Add', inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } } },
    { name: 'unknown_tool', description: '?', inputSchema: { type: 'object', properties: {} } },
  ];

  it('sends proper JSON-RPC and returns result.content', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    const res = await mgr.invokeTool('stdio', 'greet', { name: 'World' });
    expect(res).toEqual([{ type: 'text', text: 'Hello World' }]);
    proc.kill();
  });

  it('result.content is returned on success (add tool)', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    const res = await mgr.invokeTool('stdio', 'add', { a: 2, b: 3 });
    expect(res).toEqual([{ type: 'text', text: '5' }]);
    proc.kill();
  });

  it('JSON-RPC error -32602 -> InvalidArgumentsError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    await expect(mgr.invokeTool('stdio', 'unknown_tool', {})).rejects.toThrow(InvalidArgumentsError);
    proc.kill();
  });

  it('JSON-RPC error other code -> McpInvokeError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript({ errorCode: -32000 }), stdioTools);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(McpInvokeError);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow('Custom error');
    proc.kill();
  });

  it('isError flag -> McpInvokeError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript({ alwaysIsError: true }), stdioTools);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(McpInvokeError);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow('reported an error');
    proc.kill();
  });

  it('timeout -> TimeoutError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript({ hangOnCall: true }), stdioTools);
    await expect(mgr.invokeTool('stdio', 'greet', {}, { timeoutMs: 500 })).rejects.toThrow(TimeoutError);
    proc.kill();
  });

  it('no stdin/stdout -> TransportError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    await mgr.startServer('stdio');
    const mi = mgr as unknown as Record<string, unknown>;
    (mi.toolsCache as Map<string, unknown[]>).set('stdio', stdioTools);
    (mi.toolsCacheInitialized as Set<string>).add('stdio');
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(TransportError);
  });
});

// ═══════════════════ Suite 4: invokeTool SSE ═════════════════

describe('invokeTool SSE transport', () => {
  let McpManager: any, TransportError: any, TimeoutError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpManager = m.McpManager;
    TransportError = m.TransportError;
    TimeoutError = m.TimeoutError;
  });

  afterEach(() => {
    delete (globalThis as any).fetch;
  });

  const sseTools = [
    { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
  ];

  function setupSseHandle(mgr: any, serverName: string) {
    const mi = mgr as unknown as Record<string, unknown>;
    (mi.handles as Map<string, unknown>).set(serverName, { abortController: new AbortController() });
    (mi.toolsCache as Map<string, unknown[]>).set(serverName, sseTools);
    (mi.toolsCacheInitialized as Set<string>).add(serverName);
    (mi.startedAt as Map<string, string>).set(serverName, new Date().toISOString());
  }

  it('sends HTTP POST and returns result.content on success', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'sse': sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () => ({
      ok: true, status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text: 'SSE hello' }] } }),
    });

    const res = await mgr.invokeTool('sse', 'greet', {});
    expect(res).toEqual([{ type: 'text', text: 'SSE hello' }]);
  });

  it('non-2xx response -> TransportError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'sse': sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () => ({ ok: false, status: 500 } as Response);

    await expect(mgr.invokeTool('sse', 'greet', {})).rejects.toThrow(TransportError);
  });

  it('timeout -> TimeoutError (SSE)', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'sse': sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    // Mock fetch that respects AbortSignal
    (globalThis as any).fetch = async (_url: string, init?: any) => {
      // Return a promise that rejects when the signal aborts
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }
      }) as any;
    };

    await expect(mgr.invokeTool('sse', 'greet', {}, { timeoutMs: 500 })).rejects.toThrow(TimeoutError);
  });
});

// ═══════════════════ Suite 5: Invocation Stats ═══════════════

describe('Invocation stats tracking', () => {
  let McpManager: any;

  beforeAll(async () => {
    McpManager = (await impMcp()).McpManager;
  });

  it('getInvocationStats() returns empty initially', () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {});
    const mgr = new McpManager(r);
    expect(mgr.getInvocationStats()).toEqual({});
  });

  it('stats tracked after successful invocation', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const tools = [{ name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    await mgr.invokeTool('stdio', 'greet', { name: 'Stats' });
    const stats = mgr.getInvocationStats();
    expect(stats).toHaveProperty('stdio:greet');
    expect(stats['stdio:greet'].total).toBe(1);
    expect(stats['stdio:greet'].success).toBe(1);
    expect(stats['stdio:greet'].error).toBe(0);
    expect(stats['stdio:greet'].lastInvokedAt).toBeDefined();
    proc.kill();
  });

  it('stats tracked after failed invocation', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
      { name: 'bad', description: '?', inputSchema: { type: 'object', properties: {} } },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    await expect(mgr.invokeTool('stdio', 'bad', {})).rejects.toThrow();
    const stats = mgr.getInvocationStats();
    const badKey = Object.keys(stats).find(k => k.includes('bad'));
    expect(badKey).toBeDefined();
    if (badKey) {
      expect(stats[badKey].total).toBe(1);
      expect(stats[badKey].success).toBe(0);
      expect(stats[badKey].error).toBe(1);
    }
    proc.kill();
  });
});

// ═══════════════════ Suite 6: Event Logging ══════════════════

describe('Event logging for MCP invocations', () => {
  let McpManager: any;

  beforeAll(async () => {
    McpManager = (await impMcp()).McpManager;
  });

  it('logs mcp_tool_invocation event on success', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const appended: any[] = [];
    mgr.setEventLogger({ appendEvent: (e: any) => { appended.push(e); } });
    const tools = [{ name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    await mgr.invokeTool('stdio', 'greet', { name: 'Log' });
    const evt = appended.find((e: any) => e.kind === 'mcp_tool_invocation');
    expect(evt).toBeDefined();
    expect(evt.success).toBe(true);
    expect(evt.server).toBe('stdio');
    expect(evt.tool).toBe('greet');
    expect(evt.duration_ms).toBeGreaterThanOrEqual(0);
    proc.kill();
  });

  it('logs mcp_tool_invocation event on failure with error message', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const appended: any[] = [];
    mgr.setEventLogger({ appendEvent: (e: any) => { appended.push(e); } });
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
      { name: 'bad_tool', description: '?', inputSchema: { type: 'object', properties: {} } },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    await expect(mgr.invokeTool('stdio', 'bad_tool', {})).rejects.toThrow();
    const evt = appended.find((e: any) => e.kind === 'mcp_tool_invocation' && !e.success);
    expect(evt).toBeDefined();
    expect(evt.success).toBe(false);
    expect(evt.server).toBe('stdio');
    expect(evt.tool).toBe('bad_tool');
    expect(evt.error).toBeDefined();
    proc.kill();
  });
});

// ═══════════════════ Suite 7: AgentAdapter + ContentSupervisor ═

describe('AgentAdapter callMcpTool + ContentSupervisor', () => {
  let AgentAdapter: any, McpManager: any;

  beforeAll(async () => {
    const mcpMod = await impMcp();
    McpManager = mcpMod.McpManager;
    const aaMod = await import('../../src/agents/agent-adapter.js');
    AgentAdapter = aaMod.AgentAdapter;
  });

  function makeAdapter(root: string) {
    const sd = join(root, '.saivage');
    return new AgentAdapter({
      projectRoot: root,
      saivageDir: sd,
      config: { server: { port: 8080 }, models: { default: ['m'] }, providers: { p: { priority: 1, models: ['m'], apiKey: 'k' } } },
    });
  }

  it('callMcpTool works when McpManager is set', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const tools = [{ name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const res = await adapter.callMcpTool('stdio', 'greet', { name: 'Agent' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Agent' }]);
    proc.kill();
  });

  it('callMcpTool throws when no McpManager is set', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {});
    const adapter = makeAdapter(r);
    await expect(adapter.callMcpTool('s', 't', {})).rejects.toThrow('MCP manager not configured');
  });

  it('ContentSupervisor: when disabled, passes through', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const tools = [{ name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const { ContentSupervisor } = await import('../../src/utils/content-supervisor.js');
    const sd = join(r, '.saivage');
    const swd = join(r, '.saivage-work');
    mkdirSync(swd, { recursive: true });
    const cs = new ContentSupervisor({ enabled: false, maxScanLengthBytes: 10000, saivageDir: sd, saivageWorkDir: swd });
    adapter.setContentSupervisor(cs);
    const res = await adapter.callMcpTool('stdio', 'greet', { name: 'Safe' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Safe' }]);
    proc.kill();
  });

  it('ContentSupervisor: when enabled, content passes through for safe content', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { 'stdio': stdioCfg({ command: 'node', args: ['-e', '1'] }) } });
    const mgr = new McpManager(r);
    const tools = [{ name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } }];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const { ContentSupervisor } = await import('../../src/utils/content-supervisor.js');
    const sd = join(r, '.saivage');
    const swd = join(r, '.saivage-work');
    mkdirSync(swd, { recursive: true });
    const cs = new ContentSupervisor({ enabled: true, maxScanLengthBytes: 10000, saivageDir: sd, saivageWorkDir: swd });
    adapter.setContentSupervisor(cs);
    const res = await adapter.callMcpTool('stdio', 'greet', { name: 'Safe' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Safe' }]);
    proc.kill();
  });
});

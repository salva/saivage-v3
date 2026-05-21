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

let nextPid = 12345;

function createMockProc() {
  const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
  const pid = nextPid++;
  const proc: Record<string, unknown> = {
    pid,
    killed: false,
    exitCode: null as number | null,
    stdin: null,
    stdout: null,
    on: jest.fn((e: string, h: (...args: unknown[]) => void) => {
      (handlers[e] ??= []).push(h);
      return proc;
    }),
    once: jest.fn((e: string, h: (...args: unknown[]) => void) => {
      (handlers[e] ??= []).push(h);
      return proc;
    }),
    kill: jest.fn((sig?: string) => {
      proc.killed = true;
      proc.exitCode = sig === 'SIGKILL' ? 137 : 0;
      for (const h of [...(handlers['exit'] ?? [])]) {
        try {
          h(proc.exitCode, sig ?? 'SIGTERM');
        } catch {
          /* ok */
        }
      }
      delete handlers['exit'];
      return true;
    }),
  };
  return proc;
}

const mockSpawn = jest.fn(() => createMockProc());

jest.unstable_mockModule('node:child_process', () => ({ spawn: mockSpawn }));

const testRoots: string[] = [];

function makeProjectRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'saivage-mcp-invoke-test-'));
  testRoots.push(dir);
  return dir;
}

function writeSaivageJson(root: string, overrides: Record<string, unknown>): void {
  const sd = join(root, '.saivage');
  mkdirSync(sd, { recursive: true });
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify(
      {
        server: { port: 8080, host: '127.0.0.1' },
        models: { default: ['test-model'] },
        providers: { test: { priority: 10, models: ['test-model'], apiKey: 'sk' } },
        ...overrides,
      },
      null,
      2,
    ),
  );
}

function stdioCfg(overrides: Record<string, unknown> = {}) {
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

function sseCfg(overrides: Record<string, unknown> = {}) {
  return {
    url: 'http://localhost:9999/sse',
    transport: 'sse',
    disabled: false,
    autostart: true,
    ...overrides,
  };
}

function mcpScript(opts?: {
  alwaysIsError?: boolean;
  hangOnCall?: boolean;
  errorCode?: number;
}): string {
  const isErr = opts?.alwaysIsError ?? false;
  const hang = opts?.hangOnCall ?? false;
  const errCode = opts?.errorCode ?? -32602;
  const callHandler = hang
    ? '/* hang: no response */'
    : `
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

async function setupRealProc(
  mgr: unknown,
  serverName: string,
  root: string,
  script: string,
  toolDefs: unknown[],
) {
  const m = mgr as Record<string, unknown>;
  const sp = join(root, 'mcp-' + serverName + '.js');
  writeFileSync(sp, script);
  const proc = realSpawn('node', [sp], { stdio: ['pipe', 'pipe', 'pipe'] });
  await new Promise((r) => setTimeout(r, 150));

  (m.handles as Map<string, unknown>).set(serverName, { process: proc });
  (m.toolsCache as Map<string, unknown[]>).set(serverName, toolDefs);
  (m.toolsCacheInitialized as Set<string>).add(serverName);
  (m.startedAt as Map<string, string>).set(serverName, new Date().toISOString());
  return proc;
}

afterEach(() => {
  mockSpawn.mockClear();
  nextPid = 12345;
  for (const d of testRoots)
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* ok */
    }
  testRoots.length = 0;
});

async function impMcp() {
  return await import('../../src/mcp/mcp-manager.js');
}

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
    writeSaivageJson(r, { mcpServers: { test: stdioCfg() } });
    const mgr = new McpManager(r);
    await expect(mgr.invokeTool('test', 'greet', {})).rejects.toThrow(ServerNotRunningError);
  });

  it('throws ToolNotFoundError when tool not in cache', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { test: stdioCfg() } });
    const mgr = new McpManager(r);
    await mgr.startServer('test');
    await expect(mgr.invokeTool('test', 'no-such-tool', {})).rejects.toThrow(ToolNotFoundError);
  });

  it('throws ToolNotFoundError for tool in different server cache', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { srv1: stdioCfg({ command: 'c1' }), srv2: stdioCfg({ command: 'c2' }) },
    });
    const mgr = new McpManager(r);
    await mgr.startServer('srv1');
    await mgr.startServer('srv2');
    await expect(mgr.invokeTool('srv1', 'anything', {})).rejects.toThrow(ToolNotFoundError);
  });
});

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
    {
      name: 'greet',
      description: 'Hi',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    {
      name: 'add',
      description: 'Add',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    },
    { name: 'unknown_tool', description: '?', inputSchema: { type: 'object', properties: {} } },
  ];

  it('sends proper JSON-RPC and returns result.content', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    const res = await mgr.invokeTool('stdio', 'greet', { name: 'World' });
    expect(res).toEqual([{ type: 'text', text: 'Hello World' }]);
    proc.kill();
  });

  it('result.content is returned on success (add tool)', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    const res = await mgr.invokeTool('stdio', 'add', { a: 2, b: 3 });
    expect(res).toEqual([{ type: 'text', text: '5' }]);
    proc.kill();
  });

  it('JSON-RPC error -32602 -> InvalidArgumentsError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);
    await expect(mgr.invokeTool('stdio', 'unknown_tool', {})).rejects.toThrow(
      InvalidArgumentsError,
    );
    proc.kill();
  });

  it('JSON-RPC error other code -> McpInvokeError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript({ errorCode: -32000 }), stdioTools);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(McpInvokeError);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow('Custom error');
    proc.kill();
  });

  it('isError flag -> McpInvokeError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(
      mgr,
      'stdio',
      r,
      mcpScript({ alwaysIsError: true }),
      stdioTools,
    );
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(McpInvokeError);
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow('reported an error');
    proc.kill();
  });

  it('timeout -> TimeoutError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript({ hangOnCall: true }), stdioTools);
    await expect(mgr.invokeTool('stdio', 'greet', {}, { timeoutMs: 500 })).rejects.toThrow(
      TimeoutError,
    );
    proc.kill();
  });

  it('no stdin/stdout -> TransportError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    await mgr.startServer('stdio');
    const mi = mgr as unknown as Record<string, unknown>;
    (mi.toolsCache as Map<string, unknown[]>).set('stdio', stdioTools);
    (mi.toolsCacheInitialized as Set<string>).add('stdio');
    await expect(mgr.invokeTool('stdio', 'greet', {})).rejects.toThrow(TransportError);
  });
});

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
    (mi.handles as Map<string, unknown>).set(serverName, {
      abortController: new AbortController(),
    });
    (mi.toolsCache as Map<string, unknown[]>).set(serverName, sseTools);
    (mi.toolsCacheInitialized as Set<string>).add(serverName);
    (mi.startedAt as Map<string, string>).set(serverName, new Date().toISOString());
  }

  it('sends HTTP POST and returns result.content on success', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { content: [{ type: 'text', text: 'SSE hello' }] },
      }),
    });

    const res = await mgr.invokeTool('sse', 'greet', {});
    expect(res).toEqual([{ type: 'text', text: 'SSE hello' }]);
  });

  it('accepts text/event-stream tools/call responses and ignores unrelated notifications', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async (_url: string, init?: any) => {
      const id = JSON.parse(init.body).id;
      return sseResponse(
        sseData({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } }) +
          sseData({ jsonrpc: '2.0', id: id + 99, result: { ignored: true } }) +
          sseData({
            jsonrpc: '2.0',
            id,
            result: { content: [{ type: 'text', text: 'SSE hello' }] },
          }),
      );
    };

    const res = await mgr.invokeTool('sse', 'greet', {});
    expect(res).toEqual([{ type: 'text', text: 'SSE hello' }]);
  });

  it('propagates captured Mcp-Session-Id on tools/call requests', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');
    const mi = mgr as unknown as Record<string, unknown>;
    const handle = (mi.handles as Map<string, any>).get('sse');
    handle.streamableHttpSessionId = 'synthetic-session-1';

    const fetchMock = jest.fn(async (_url: string, init?: any) => {
      const id = JSON.parse(init.body).id;
      return sseResponse(sseData({ jsonrpc: '2.0', id, result: { content: [] } }));
    });
    (globalThis as any).fetch = fetchMock;

    await mgr.invokeTool('sse', 'greet', {});
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ 'Mcp-Session-Id': 'synthetic-session-1' }),
      }),
    );
  });

  it('surfaces sanitized errors for malformed, overlarge, and closed SSE responses', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () =>
      sseResponse('data: {not json and secret-like value}\n\n');
    await expect(mgr.invokeTool('sse', 'greet', {})).rejects.toMatchObject({
      name: 'TransportError',
      message: expect.stringContaining('Malformed Streamable HTTP SSE data'),
    });

    (globalThis as any).fetch = async () => sseResponse(`data: ${'x'.repeat(70 * 1024)}\n\n`);
    await expect(mgr.invokeTool('sse', 'greet', {})).rejects.toMatchObject({
      name: 'TransportError',
      message: expect.stringContaining('SSE frame exceeded limit'),
    });

    (globalThis as any).fetch = async (_url: string, init?: any) => {
      const id = JSON.parse(init.body).id + 1;
      return sseResponse(sseData({ jsonrpc: '2.0', id, result: {} }));
    };
    await expect(mgr.invokeTool('sse', 'greet', {})).rejects.toMatchObject({
      name: 'TransportError',
      message: expect.stringContaining('Stream ended before JSON-RPC response for tools/call'),
    });
  });

  it('times out if an event-stream tools/call response never emits the matching id', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(': keep-alive\n\n'));
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
    };

    await expect(mgr.invokeTool('sse', 'greet', {}, { timeoutMs: 100 })).rejects.toThrow(
      TimeoutError,
    );
  });

  it('non-2xx response -> TransportError', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async () => ({ ok: false, status: 500 }) as Response;

    await expect(mgr.invokeTool('sse', 'greet', {})).rejects.toThrow(TransportError);
  });

  it('timeout -> TimeoutError (SSE)', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupSseHandle(mgr, 'sse');

    (globalThis as any).fetch = async (_url: string, init?: any) => {
      return new Promise((_resolve, reject) => {
        if (init?.signal) {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          );
        }
      }) as any;
    };

    await expect(mgr.invokeTool('sse', 'greet', {}, { timeoutMs: 500 })).rejects.toThrow(
      TimeoutError,
    );
  });
});

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
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
    ];
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
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
      { name: 'bad', description: '?', inputSchema: { type: 'object', properties: {} } },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    await expect(mgr.invokeTool('stdio', 'bad', {})).rejects.toThrow();
    const stats = mgr.getInvocationStats();
    const badKey = Object.keys(stats).find((k) => k.includes('bad'));
    expect(badKey).toBeDefined();
    if (badKey) {
      expect(stats[badKey].total).toBe(1);
      expect(stats[badKey].success).toBe(0);
      expect(stats[badKey].error).toBe(1);
    }
    proc.kill();
  });
});

describe('Event logging for MCP invocations', () => {
  let McpManager: any;

  beforeAll(async () => {
    McpManager = (await impMcp()).McpManager;
  });

  it('logs mcp_tool_invocation event on success', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const appended: any[] = [];
    mgr.setEventLogger({
      appendEvent: (e: any) => {
        appended.push(e);
      },
    });
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
    ];
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
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const appended: any[] = [];
    mgr.setEventLogger({
      appendEvent: (e: any) => {
        appended.push(e);
      },
    });
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
      config: {
        server: { port: 8080 },
        models: { default: ['m'] },
        providers: { p: { priority: 1, models: ['m'], apiKey: 'k' } },
      },
    });
  }

  it('callMcpTool works when McpManager is set', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const tools = [
      {
        name: 'greet',
        description: 'Hi',
        inputSchema: { type: 'object', properties: {}, annotations: { readOnlyHint: true } },
      },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const res = await adapter.callMcpTool('executor', 'stdio', 'greet', { name: 'Agent' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Agent' }]);
    proc.kill();
  });

  it('callMcpTool throws when no McpManager is set', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {});
    const adapter = makeAdapter(r);
    await expect(adapter.callMcpTool('executor', 's', 't', {})).rejects.toThrow(
      'MCP manager not configured',
    );
  });

  it('ContentSupervisor: when disabled, passes through', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const { ContentSupervisor } = await import('../../src/utils/content-supervisor.js');
    const sd = join(r, '.saivage');
    const swd = join(r, '.saivage-work');
    mkdirSync(swd, { recursive: true });
    const cs = new ContentSupervisor({
      enabled: false,
      maxScanLengthBytes: 10000,
      saivageDir: sd,
      saivageWorkDir: swd,
    });
    adapter.setContentSupervisor(cs);
    const res = await adapter.callMcpTool('executor', 'stdio', 'greet', { name: 'Safe' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Safe' }]);
    proc.kill();
  });

  it('ContentSupervisor: when enabled, content passes through for safe content', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const tools = [
      { name: 'greet', description: 'Hi', inputSchema: { type: 'object', properties: {} } },
    ];
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), tools);
    const adapter = makeAdapter(r);
    adapter.setMcpManager(mgr);
    const { ContentSupervisor } = await import('../../src/utils/content-supervisor.js');
    const sd = join(r, '.saivage');
    const swd = join(r, '.saivage-work');
    mkdirSync(swd, { recursive: true });
    const cs = new ContentSupervisor({
      enabled: true,
      maxScanLengthBytes: 10000,
      saivageDir: sd,
      saivageWorkDir: swd,
    });
    adapter.setContentSupervisor(cs);
    const res = await adapter.callMcpTool('executor', 'stdio', 'greet', { name: 'Safe' });
    expect(res).toEqual([{ type: 'text', text: 'Hello Safe' }]);
    proc.kill();
  });
});

describe('Stdio invocation queue', () => {
  let McpManager: any, TransportError: any, TimeoutError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpManager = m.McpManager;
    TransportError = m.TransportError;
    TimeoutError = m.TimeoutError;
  });

  const stdioTools = [
    {
      name: 'greet',
      description: 'Hi',
      inputSchema: { type: 'object', properties: { name: { type: 'string' } } },
    },
    {
      name: 'add',
      description: 'Add',
      inputSchema: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } } },
    },
  ];

  function orderingScript(): string {
    return `
const rl = require('readline').createInterface({ input: process.stdin });
const order = [];
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ protocolVersion:'2025-06-18', capabilities:{}, serverInfo:{ name:'test', version:'1.0' } } }) + '\\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ tools:[ {name:'greet',description:'Hi',inputSchema:{type:'object',properties:{name:{type:'string'}}}}, {name:'add',description:'Add',inputSchema:{type:'object',properties:{a:{type:'number'},b:{type:'number'}}}} ] } }) + '\\n');
  } else if (req.method === 'tools/call') {
    const toolName = req.params && req.params.name;
    const delay = toolName === 'greet' ? 200 : 50;
    setTimeout(() => {
      order.push(toolName);
      if (toolName === 'greet') {
        const name = (req.params.arguments && req.params.arguments.name) || 'unknown';
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{type:'text',text:'Hello '+name+' (order:'+order.join(',')+')'}] } }) + '\\n');
      } else if (toolName === 'add') {
        const a = (req.params.arguments && req.params.arguments.a) || 0;
        const b = (req.params.arguments && req.params.arguments.b) || 0;
        process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{type:'text',text:String(a+b)+' (order:'+order.join(',')+')'}] } }) + '\\n');
      }
    }, delay);
  }
});
`;
  }

  function errorThenOkScript(): string {
    return `
const rl = require('readline').createInterface({ input: process.stdin });
let callCount = 0;
rl.on('line', (line) => {
  let req;
  try { req = JSON.parse(line); } catch { return; }
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ protocolVersion:'2025-06-18', capabilities:{}, serverInfo:{ name:'test', version:'1.0' } } }) + '\\n');
  } else if (req.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ tools:[ {name:'greet',description:'Hi',inputSchema:{type:'object',properties:{name:{type:'string'}}}} ] } }) + '\\n');
  } else if (req.method === 'tools/call') {
    callCount++;
    if (callCount === 1) {
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, error:{ code:-32603, message:'Internal error on first call' } }) + '\\n');
    } else {
      const name = (req.params.arguments && req.params.arguments.name) || 'unknown';
      process.stdout.write(JSON.stringify({ jsonrpc:'2.0', id:req.id, result:{ content:[{type:'text',text:'Hello '+name+' (call #'+callCount+')'}] } }) + '\\n');
    }
  }
});
`;
  }

  it('serializes concurrent calls to the same stdio server (ordering test)', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, orderingScript(), stdioTools);

    const [res1, res2] = await Promise.all([
      mgr.invokeTool('stdio', 'greet', { name: 'First' }),
      mgr.invokeTool('stdio', 'add', { a: 10, b: 20 }),
    ]);

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    const text1 = Array.isArray(res1) ? (res1[0] as any)?.text : '';
    const text2 = Array.isArray(res2) ? (res2[0] as any)?.text : '';

    expect(text1).toContain('Hello');
    expect(text1).toContain('greet');
    expect(text2).toContain('30');
    expect(text1).toContain('order:greet');
    expect(text2).toContain('add');

    const stats = mgr.getInvocationStats();
    expect(stats['stdio:greet']).toBeDefined();
    expect(stats['stdio:add']).toBeDefined();
    expect(stats['stdio:greet'].success).toBe(1);
    expect(stats['stdio:add'].success).toBe(1);

    proc.kill();
  }, 15000);

  it('concurrent calls to different stdio servers do NOT block each other', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: {
        srv1: stdioCfg({ command: 'node', args: ['-e', '1'] }),
        srv2: stdioCfg({ command: 'node', args: ['-e', '1'] }),
      },
    });
    const mgr = new McpManager(r);
    const proc1 = await setupRealProc(mgr, 'srv1', r, orderingScript(), stdioTools);
    const proc2 = await setupRealProc(mgr, 'srv2', r, orderingScript(), stdioTools);

    const start = Date.now();
    const [res1, res2] = await Promise.all([
      mgr.invokeTool('srv1', 'greet', { name: 'From1' }),
      mgr.invokeTool('srv2', 'greet', { name: 'From2' }),
    ]);
    const elapsed = Date.now() - start;

    expect(res1).toBeDefined();
    expect(res2).toBeDefined();

    const text1 = Array.isArray(res1) ? (res1[0] as any)?.text : '';
    const text2 = Array.isArray(res2) ? (res2[0] as any)?.text : '';
    expect(text1).toContain('From1');
    expect(text2).toContain('From2');
    expect(elapsed).toBeLessThan(350);

    proc1.kill();
    proc2.kill();
  }, 15000);

  it('SSE concurrent calls are NOT serialized', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    const mi = mgr as unknown as Record<string, unknown>;

    (mi.handles as Map<string, unknown>).set('sse', { abortController: new AbortController() });
    (mi.toolsCache as Map<string, unknown[]>).set('sse', stdioTools);
    (mi.toolsCacheInitialized as Set<string>).add('sse');
    (mi.startedAt as Map<string, string>).set('sse', new Date().toISOString());

    let concurrent = 0;
    let maxConcurrent = 0;

    (globalThis as any).fetch = async (_url: string, init?: any) => {
      concurrent++;
      if (concurrent > maxConcurrent) maxConcurrent = concurrent;
      await new Promise((r) => setTimeout(r, 100));
      concurrent--;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { content: [{ type: 'text', text: 'SSE result' }] },
        }),
      } as Response;
    };

    const start = Date.now();
    const [res1, res2, res3] = await Promise.all([
      mgr.invokeTool('sse', 'greet', {}),
      mgr.invokeTool('sse', 'greet', {}),
      mgr.invokeTool('sse', 'greet', {}),
    ]);
    const elapsed = Date.now() - start;

    expect(res1).toEqual([{ type: 'text', text: 'SSE result' }]);
    expect(res2).toEqual([{ type: 'text', text: 'SSE result' }]);
    expect(res3).toEqual([{ type: 'text', text: 'SSE result' }]);
    expect(maxConcurrent).toBeGreaterThan(1);
    expect(elapsed).toBeLessThan(250);

    delete (globalThis as any).fetch;
  }, 15000);

  it('error in one queued call does not break subsequent calls', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, errorThenOkScript(), stdioTools);

    await expect(mgr.invokeTool('stdio', 'greet', { name: 'Fail' })).rejects.toThrow();

    const res = await mgr.invokeTool('stdio', 'greet', { name: 'AfterFail' });
    expect(res).toBeDefined();
    const text = Array.isArray(res) ? (res[0] as any)?.text : '';
    expect(text).toContain('AfterFail');

    const stats = mgr.getInvocationStats();
    expect(stats['stdio:greet'].total).toBe(2);
    expect(stats['stdio:greet'].success).toBe(1);
    expect(stats['stdio:greet'].error).toBe(1);

    proc.kill();
  }, 15000);

  it('concurrent quick calls all return correct results without timeout', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), stdioTools);

    const promises = [
      mgr.invokeTool('stdio', 'greet', { name: 'A' }),
      mgr.invokeTool('stdio', 'add', { a: 1, b: 2 }),
      mgr.invokeTool('stdio', 'greet', { name: 'B' }),
      mgr.invokeTool('stdio', 'add', { a: 10, b: 20 }),
      mgr.invokeTool('stdio', 'greet', { name: 'C' }),
    ];

    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
    expect(results[0]).toEqual([{ type: 'text', text: 'Hello A' }]);
    expect(results[1]).toEqual([{ type: 'text', text: '3' }]);
    expect(results[2]).toEqual([{ type: 'text', text: 'Hello B' }]);
    expect(results[3]).toEqual([{ type: 'text', text: '30' }]);
    expect(results[4]).toEqual([{ type: 'text', text: 'Hello C' }]);

    proc.kill();
  }, 15000);
});

describe('ARCH-018 local MCP inputSchema validation', () => {
  let McpManager: any, InvalidArgumentsError: any, TransportError: any;

  beforeAll(async () => {
    const m = await impMcp();
    McpManager = m.McpManager;
    InvalidArgumentsError = m.InvalidArgumentsError;
    TransportError = m.TransportError;
  });

  function setupBareRunningServer(
    mgr: any,
    serverName: string,
    tools: unknown[],
    transport: 'stdio' | 'sse' = 'stdio',
  ) {
    const mi = mgr as unknown as Record<string, unknown>;
    if (transport === 'stdio') {
      (mi.handles as Map<string, unknown>).set(serverName, {
        process: { killed: false, exitCode: null, stdin: null, stdout: null },
      });
    } else {
      (mi.handles as Map<string, unknown>).set(serverName, {
        abortController: new AbortController(),
      });
    }
    (mi.toolsCache as Map<string, unknown[]>).set(serverName, tools);
    (mi.toolsCacheInitialized as Set<string>).add(serverName);
    (mi.startedAt as Map<string, string>).set(serverName, new Date().toISOString());
  }

  const strictTool = {
    name: 'strict',
    description: 'strict object schema',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'integer', minimum: 1 },
        mode: { enum: ['fast', 'safe'] },
      },
      required: ['name', 'count'],
      additionalProperties: false,
    },
  };

  it('rejects invalid stdio arguments before touching transport', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    setupBareRunningServer(mgr, 'local', [strictTool]);

    await expect(mgr.invokeTool('local', 'strict', { name: 'Ada', count: '2' })).rejects.toThrow(
      InvalidArgumentsError,
    );
    await expect(
      mgr.invokeTool('local', 'strict', { name: 'Ada', count: '2' }),
    ).rejects.toMatchObject({
      data: {
        source: 'local_input_schema_validation',
        reason: 'validation_error',
      },
    });
    expect(mgr.getInvocationStats()).toEqual({});
  });

  it('allows locally valid stdio arguments through to the existing transport path', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    setupBareRunningServer(mgr, 'local', [strictTool]);

    await expect(
      mgr.invokeTool('local', 'strict', { name: 'Ada', count: 2, mode: 'safe' }),
    ).rejects.toThrow(TransportError);
    expect(mgr.getInvocationStats()['local:strict'].error).toBe(1);
  });

  it('rejects invalid SSE arguments before issuing fetch', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { sse: sseCfg() } });
    const mgr = new McpManager(r);
    setupBareRunningServer(mgr, 'sse', [strictTool], 'sse');
    const fetchMock = jest.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ result: {} }),
    }));
    (globalThis as any).fetch = fetchMock;

    await expect(mgr.invokeTool('sse', 'strict', { name: 'Ada', count: 0 })).rejects.toThrow(
      InvalidArgumentsError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mgr.getInvocationStats()).toEqual({});
    delete (globalThis as any).fetch;
  });

  it('fails closed for missing, unsupported, and uncompileable schemas with safe reasons', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    setupBareRunningServer(mgr, 'local', [
      { name: 'missing', inputSchema: undefined },
      { name: 'unsupported', inputSchema: { type: 'array', items: { type: 'string' } } },
      {
        name: 'bad-schema',
        inputSchema: { type: 'object', properties: { x: { type: 'not-json-schema' } } },
      },
    ]);

    await expect(mgr.invokeTool('local', 'missing', {})).rejects.toMatchObject({
      data: { reason: 'schema_missing' },
    });
    await expect(mgr.invokeTool('local', 'unsupported', {})).rejects.toMatchObject({
      data: { reason: 'schema_unsupported' },
    });
    await expect(mgr.invokeTool('local', 'bad-schema', {})).rejects.toMatchObject({
      data: { reason: 'schema_compile_error' },
    });
    expect(mgr.getInvocationStats()).toEqual({});
  });

  it('uses a new validator when the cached tool schema fingerprint changes', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    const mi = mgr as unknown as Record<string, unknown>;
    setupBareRunningServer(mgr, 'local', [
      {
        name: 'flip',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
        },
      },
    ]);

    await expect(mgr.invokeTool('local', 'flip', { value: 7 })).rejects.toMatchObject({
      data: { reason: 'validation_error' },
    });

    (mi.toolsCache as Map<string, unknown[]>).set('local', [
      {
        name: 'flip',
        inputSchema: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
        },
      },
    ]);

    await expect(mgr.invokeTool('local', 'flip', { value: 7 })).rejects.toThrow(TransportError);
    expect(mgr.getInvocationStats()['local:flip'].error).toBe(1);
  });

  it('keeps local validation diagnostics free of raw synthetic secret values', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    setupBareRunningServer(mgr, 'local', [strictTool]);
    const syntheticSecret = 'sk-test-ARCH018-DO-NOT-ECHO-1234567890';
    const syntheticSecretKey = `x-api-token-${syntheticSecret}`;

    try {
      await mgr.invokeTool('local', 'strict', {
        name: syntheticSecret,
        count: 'nope',
        [syntheticSecretKey]: 'extra-value',
      });
      throw new Error('expected local validation failure');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentsError);
      const rendered = JSON.stringify({ message: (err as Error).message, data: (err as any).data });
      expect(rendered).not.toContain(syntheticSecret);
      expect(rendered).not.toContain(syntheticSecretKey);
      expect(rendered).toContain('expectedType');
      expect(rendered).toContain('additionalProperty');
      expect(rendered).toContain('<argument-property>');
    }
  });

  it('bounds long enum and pattern diagnostics', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, { mcpServers: { local: stdioCfg({ command: 'node' }) } });
    const mgr = new McpManager(r);
    const longPattern = `^${'a'.repeat(300)}$`;
    const longEnumValue = `enum-${'b'.repeat(300)}`;
    setupBareRunningServer(mgr, 'local', [
      {
        name: 'bounded',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: Array.from({ length: 20 }, (_, i) =>
                i === 0 ? longEnumValue : `allowed-${i}`,
              ),
            },
            code: { type: 'string', pattern: longPattern },
          },
          required: ['mode', 'code'],
        },
      },
    ]);

    try {
      await mgr.invokeTool('local', 'bounded', { mode: 'denied', code: 'x' });
      throw new Error('expected local validation failure');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidArgumentsError);
      const diagnostics = (err as any).data?.diagnostics as Array<Record<string, unknown>>;
      const rendered = JSON.stringify({ message: (err as Error).message, data: (err as any).data });
      expect(rendered).not.toContain('a'.repeat(121));
      expect(rendered).not.toContain('b'.repeat(121));

      const enumDiagnostic = diagnostics.find((diagnostic) => diagnostic.keyword === 'enum');
      expect(Array.isArray(enumDiagnostic?.allowedValues)).toBe(true);
      expect((enumDiagnostic?.allowedValues as unknown[]).length).toBeLessThanOrEqual(8);
      for (const value of enumDiagnostic?.allowedValues as unknown[]) {
        if (typeof value === 'string') {
          expect(value.length).toBeLessThanOrEqual(121);
        }
      }

      const patternDiagnostic = diagnostics.find((diagnostic) => diagnostic.keyword === 'pattern');
      expect(typeof patternDiagnostic?.pattern).toBe('string');
      expect((patternDiagnostic?.pattern as string).length).toBeLessThanOrEqual(121);
    }
  });

  it('preserves remote JSON-RPC invalid-params fallback for locally valid calls', async () => {
    const r = makeProjectRoot();
    writeSaivageJson(r, {
      mcpServers: { stdio: stdioCfg({ command: 'node', args: ['-e', '1'] }) },
    });
    const mgr = new McpManager(r);
    const proc = await setupRealProc(mgr, 'stdio', r, mcpScript(), [
      { name: 'unknown_tool', description: '?', inputSchema: { type: 'object', properties: {} } },
    ]);

    await expect(mgr.invokeTool('stdio', 'unknown_tool', {})).rejects.toThrow(
      InvalidArgumentsError,
    );
    await expect(mgr.invokeTool('stdio', 'unknown_tool', {})).rejects.toMatchObject({
      data: undefined,
    });
    proc.kill();
  });
});

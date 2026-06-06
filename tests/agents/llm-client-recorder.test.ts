/**
 * Tests that verify LlmClient invokes the LlmExchangeRecorder correctly at
 * each capture point: non-stream success, stream success (tee correctness),
 * HTTP errors, network errors, parse errors, Codex success, Codex
 * max_tokens omission, and recorder failure isolation.
 */
import { afterEach, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LlmExchangeRecorder, ExchangeHandle } from '../../src/agents/llm-exchange-recorder.js';
import { CardStore } from '../../src/cards/card-store.js';

let LlmProviderGateway: typeof import('../../src/agents/llm-provider-gateway.js').LlmProviderGateway;
let LlmRequestError: typeof import('../../src/agents/llm-failure.js').LlmRequestError;
let AgentAdapter: typeof import('../../src/agents/agent-adapter.js').AgentAdapter;
let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;

beforeAll(async () => {
  const gatewayMod = await import('../../src/agents/llm-provider-gateway.js');
  const failureMod = await import('../../src/agents/llm-failure.js');
  LlmProviderGateway = gatewayMod.LlmProviderGateway;
  LlmRequestError = failureMod.LlmRequestError;
  AgentAdapter = (await import('../../src/agents/agent-adapter.js')).AgentAdapter;
  loadConfig = (await import('../../src/agents/config-schema.js')).loadConfig;
});


import type { LlmCompleteOptions, LlmCompleteResult, ToolCall } from '../../src/agents/llm-contracts.js';

function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test.v1', contractName: 'test', terminalToolOffered: [], ...(extra as object) } as LlmCompleteOptions;
}

function asMessage(r: LlmCompleteResult): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

interface MockServer { server: Server; port: number; }
function startServer(
  handler: (req: IncomingMessage, res: ServerResponse, index: number) => void,
): Promise<MockServer> {
  return new Promise((resolve) => {
    let index = 0;
    const server = createServer((req, res) => {
      const i = index++;
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => handler(req, res, i));
      // silence body parameter warnings
      void body;
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port });
    });
  });
}

function closeServer(s: Server): Promise<void> {
  return new Promise((r) => s.close(() => r()));
}

function makeMockRecorder(): {
  recorder: LlmExchangeRecorder;
  begins: Parameters<LlmExchangeRecorder['beginExchange']>[0][];
  responses: unknown[];
  errors: unknown[];
} {
  const begins: Parameters<LlmExchangeRecorder['beginExchange']>[0][] = [];
  const responses: unknown[] = [];
  const errors: unknown[] = [];
  const recorder: LlmExchangeRecorder = {
    async beginExchange(meta) {
      begins.push(meta);
      const handle: ExchangeHandle = {
        async recordResponse(m) { responses.push(m); },
        async recordError(m) { errors.push(m); },
      };
      return handle;
    },
    async flush() { /* noop */ },
  };
  return { recorder, begins, responses, errors };
}

function createTestAgentAdapter(projectRoot: string, cardStore = new CardStore(projectRoot)): InstanceType<typeof AgentAdapter> {
  const saivageDir = join(projectRoot, '.saivage');
  const { config } = loadConfig(projectRoot);
  return new AgentAdapter({ projectRoot, saivageDir, config, cardStore });
}

const candidate = { provider: 'test-provider', account: null as string | null, model: 'test-model' };
const sys = 'sys';
const msgs = [{ id: '1', session_id: 's', role: 'user' as const, kind: 'text' as const, content: 'hi', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: '2026-01-01T00:00:00Z' }];

function okBody(content = 'hello') {
  return JSON.stringify({
    id: 'x', object: 'chat.completion', created: 0, model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
  });
}

let tmp: string[] = [];
afterEach(() => {
  for (const r of tmp) try { rmSync(r, { recursive: true, force: true }); } catch { /* */ }
  tmp = [];
});

function makeJwt(accountId: string): string {
  const h = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } })).toString('base64url');
  return `${h}.${p}.sig`;
}

describe('LlmClient + LlmExchangeRecorder integration', () => {
  it('records a single successful non-streaming response', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody('hi-back'));
    });
    try {
      const { recorder, begins, responses, errors } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk' });
      const r = await client.complete(candidate, sys, msgs, 'sess-1', toolsOpts({ recorder }));
      expect(asMessage(r).content).toBe('hi-back');
      expect(begins).toHaveLength(1);
      expect(begins[0].transport).toBe('generic');
      expect(responses).toHaveLength(1);
      expect(errors).toHaveLength(0);
      const resp = responses[0] as { status: number; bodyRaw: string; bodyParsed: { choices: unknown[] } };
      expect(resp.status).toBe(200);
      expect(JSON.parse(resp.bodyRaw).choices[0].message.content).toBe('hi-back');
      expect(resp.bodyParsed.choices).toHaveLength(1);
    } finally { await closeServer(server); }
  });

  it('records concatenated chunks via tee on streaming success', async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(chunks.join(''));
    });
    try {
      const { recorder, responses } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk' });
      const r = await client.complete(candidate, sys, msgs, 'sess-2', toolsOpts({ stream: true, recorder }));
      expect(asMessage(r).content).toBe('Hello');
      expect(responses).toHaveLength(1);
      const resp = responses[0] as { bodyRaw: string; bodyParsed: { content: string } };
      expect(resp.bodyRaw).toBe(chunks.join(''));
      expect(resp.bodyParsed.content).toBe('Hello');
    } finally { await closeServer(server); }
  });

  it('records a single HTTP-error attempt without double-recording in outer catch', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end('{"error":"boom"}');
    });
    try {
      const { recorder, responses, errors } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk' });
      await expect(client.complete(candidate, sys, msgs, 'sess-3', toolsOpts({ recorder }))).rejects.toThrow();
      expect(responses).toHaveLength(0);
      expect(errors).toHaveLength(1);
      const e = errors[0] as { status: number; bodyRaw: string };
      expect(e.status).toBe(500);
      expect(e.bodyRaw).toBe('{"error":"boom"}');
    } finally { await closeServer(server); }
  });

  it('records bodyRaw=null when fetch fails before any response', async () => {
    const { recorder, errors } = makeMockRecorder();
    // Use an unroutable port to force a network error before any body.
    const client = new LlmProviderGateway({ baseUrl: 'http://127.0.0.1:1', apiKey: 'sk' });
    await expect(client.complete(candidate, sys, msgs, 'sess-4', toolsOpts({ recorder }))).rejects.toThrow();
    expect(errors).toHaveLength(1);
    const e = errors[0] as { bodyRaw: string | null };
    expect(e.bodyRaw).toBeNull();
  });

  it('records bodyRaw=rawText on parse error', async () => {
    const garbage = 'NOT JSON';
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(garbage);
    });
    try {
      const { recorder, errors } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk' });
      await expect(client.complete(candidate, sys, msgs, 'sess-5', toolsOpts({ recorder }))).rejects.toBeInstanceOf(LlmRequestError);
      expect(errors).toHaveLength(1);
      const e = errors[0] as { errorName: string; bodyRaw: string };
      expect(e.errorName).toBe('LlmRequestError');
      expect(e.bodyRaw).toBe(garbage);
    } finally { await closeServer(server); }
  });

  it('records a Codex stream success with synthesized parsed body', async () => {
    const lines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Co' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'dex' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(lines.join(''));
    });
    try {
      const { recorder, begins, responses, errors } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwt('acct-1') });
      const r = await client.complete(
        { provider: 'openai-codex', account: null, model: 'gpt-5.4' },
        sys, msgs, 'sess-6', toolsOpts({ recorder }));
      expect(asMessage(r).content).toBe('Codex');
      expect(begins).toHaveLength(1);
      expect(begins[0].transport).toBe('codex');
      expect(errors).toHaveLength(0);
      const resp = responses[0] as { bodyRaw: string; bodyParsed: { content: string } };
      expect(resp.bodyRaw).toBe(lines.join(''));
      expect(resp.bodyParsed.content).toBe('Codex');
    } finally { await closeServer(server); }
  });

  it('records one Codex attempt and omits max_output_tokens when max_tokens is configured', async () => {
    const okLines = [
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`,
      `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
      'data: [DONE]\n\n',
    ];
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(okLines.join(''));
    });
    try {
      const { recorder, begins, responses, errors } = makeMockRecorder();
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwt('acct-1') });
      const r = await client.complete(
        { provider: 'openai-codex', account: null, model: 'gpt-5.4' },
        sys, msgs, 'sess-7', toolsOpts({ max_tokens: 500, recorder }));
      expect(asMessage(r).content).toBe('ok');
      expect(begins).toHaveLength(1);
      expect(begins[0].request.body).not.toHaveProperty('max_output_tokens');
      expect(errors).toHaveLength(0);
      expect(responses).toHaveLength(1);
      const resp = responses[0] as { bodyRaw: string };
      expect(resp.bodyRaw).toBe(okLines.join(''));
    } finally { await closeServer(server); }
  });

  it('records a single Codex network error without double-recording', async () => {
    const { recorder, begins, responses, errors } = makeMockRecorder();
    const client = new LlmProviderGateway({ baseUrl: 'http://127.0.0.1:1/backend-api', apiKey: makeJwt('acct-1') });
    await expect(client.complete(
      { provider: 'openai-codex', account: null, model: 'gpt-5.4' },
      sys, msgs, 'sess-8', toolsOpts({ recorder }))).rejects.toThrow();
    expect(begins).toHaveLength(1);
    expect(responses).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect((errors[0] as { bodyRaw: string | null }).bodyRaw).toBeNull();
  });

  it('propagates recorder failures: beginExchange throwing surfaces to the caller', async () => {
    // The recorder contract: createLlmExchangeRecorder swallows internal write
    // failures, but a recorder passed via opts may throw from beginExchange.
    // Verify the client does not silently mask that error.
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody('never-reached'));
    });
    try {
      const recorder: LlmExchangeRecorder = {
        beginExchange: jest.fn(async () => { throw new Error('recorder-down'); }) as never,
        flush: async () => { /* */ },
      };
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk' });
      await expect(client.complete(candidate, sys, msgs, 'sess-9', toolsOpts({ recorder })))
        .rejects.toThrow(/recorder-down/);
    } finally { await closeServer(server); }
  });
});

describe('AgentAdapter recorder wiring', () => {
  it('exposes flushRecorders and creates a recorder per session via createLlmCallFn', async () => {
    const { server, port } = await startServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(okBody('adapter-ok'));
    });
    try {
      const root = mkdtempSync(join(tmpdir(), 'saivage-adapter-rec-'));
      tmp.push(root);
      const { mkdirSync, writeFileSync } = await import('node:fs');
      mkdirSync(join(root, '.saivage'), { recursive: true });
      writeFileSync(
        join(root, '.saivage', 'saivage.json'),
        JSON.stringify({
          models: { default: ['test-model'] },
          providers: {
            'test-provider': {
              priority: 10,
              models: ['test-model'],
              baseUrl: `http://localhost:${port}`,
              apiKey: 'sk',
            },
          },
          runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
        }),
      );
      const adapter = createTestAgentAdapter(root, new CardStore(root));
      const fn = adapter.createLlmCallFn();
      const out = await fn(candidate, sys, msgs, 'sess-adapter-1', toolsOpts());
      expect(asMessage(out).content).toBe('adapter-ok');
      await adapter.flushRecorders();
      const { readLatestLlmExchange } = await import('../../src/agents/llm-exchange-log.js');
      const got = await readLatestLlmExchange(join(root, '.saivage'), 'sess-adapter-1');
      expect(got).not.toBeNull();
      expect(got!.attempts[0].status).toBe('ok');
    } finally { await closeServer(server); }
  });
});

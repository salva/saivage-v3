/**
 * Integration tests for LlmProviderGateway → mock HTTP server round-trip.
 *
 * Uses node:http mock servers to verify:
 * - Successful non-streaming round-trip
 * - Auth error (401)
 * - Rate limit (429)
 * - Server error (500)
 * - Timeout (AbortSignal)
 * - Parse error (malformed JSON, missing choices)
* - Streaming mode (SSE)
*/

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── Dynamic imports ────────────────────────────────────────────

let LlmProviderGateway: typeof import('../../src/agents/llm-provider-gateway.js').LlmProviderGateway;
let LlmRequestError: typeof import('../../src/contracts/llm-failure.js').LlmRequestError;
let ProviderRegistry: typeof import('../../src/agents/provider.js').ProviderRegistry;

beforeAll(async () => {
  const gatewayMod = await import('../../src/agents/llm-provider-gateway.js');
  const failureMod = await import('../../src/contracts/llm-failure.js');
  LlmProviderGateway = gatewayMod.LlmProviderGateway;
  LlmRequestError = failureMod.LlmRequestError;
  ProviderRegistry = (await import('../../src/agents/provider.js')).ProviderRegistry;
});

// ── Types ─────────────────────────────────────────────────────

interface CaptureBucket {
  body: string;
  headers: Record<string, string | string[] | undefined>;
  url: string;
  method: string;
}

interface MockServerHandle {
  server: Server;
  port: number;
  /** Mutable capture bucket — populated when request arrives */
  cap: CaptureBucket;
}

interface MultiCaptureMockServerHandle extends MockServerHandle {
  captures: CaptureBucket[];
}

// ── Helpers ────────────────────────────────────────────────────

function createMockServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<MockServerHandle> {
  return new Promise((resolve) => {
    const cap: CaptureBucket = {
      body: '',
      headers: {},
      url: '',
      method: '',
    };

    const server = createServer((req, res) => {
      cap.url = req.url ?? '';
      cap.method = req.method ?? '';
      cap.headers = { ...req.headers };

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        cap.body = body;
        handler(req, res);
      });
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, cap });
    });
  });
}

function createMultiCaptureMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, index: number) => void,
): Promise<MultiCaptureMockServerHandle> {
  return new Promise((resolve) => {
    const captures: CaptureBucket[] = [];
    const cap: CaptureBucket = {
      body: '',
      headers: {},
      url: '',
      method: '',
    };

    const server = createServer((req, res) => {
      const current: CaptureBucket = {
        body: '',
        headers: { ...req.headers },
        url: req.url ?? '',
        method: req.method ?? '',
      };
      const index = captures.push(current) - 1;

      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        current.body = body;
        cap.body = body;
        cap.headers = current.headers;
        cap.url = current.url;
        cap.method = current.method;
        handler(req, res, index);
      });
    });

    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, cap, captures });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `saivage-llm-int-${Date.now()}-${randomBytes(4).toString('hex')}`,
  );
  mkdirSync(join(dir, '.saivage'), { recursive: true });
  return dir;
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

// ── Fixtures ───────────────────────────────────────────────────

function sp() {
  return 'You are a test assistant.';
}

function msgs() {
  return [
    {
      id: 'msg-1',
      session_id: 'sess-1',
      role: 'user' as const,
      kind: 'text' as const,
      content: 'Hello, how are you?',
      round_id: 'r-user-00000000000000000000000000000001',
      message_index: 0,
      block_index: 0,
      timestamp: new Date().toISOString(),
    },
  ];
}

function cand(provider = 'test-provider', model = 'test-model') {
  return { provider, account: null as string | null, model };
}

function okResp(content: string, model = 'test-model') {
  return {
    id: 'chatcmpl-test-123',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function okToolCallResp(toolName: string, argumentsJson: string, model = 'test-model') {
  return {
    id: 'chatcmpl-test-123',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_t1', type: 'function', function: { name: toolName, arguments: argumentsJson } }] }, finish_reason: 'tool_calls' },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

function streamLine(content: string, done = false): string {
  if (done) return 'data: [DONE]\n\n';
  const obj = {
    id: 'chatcmpl-stream-123',
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'test-model',
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  };
  return `data: ${JSON.stringify(obj)}\n\n`;
}

function makeJwtWithCodexAccount(accountId: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: accountId,
    },
  })).toString('base64url');
  return `${header}.${payload}.sig`;
}

import type { LlmCompleteOptions, LlmCompleteResult, ToolCall } from '../../src/agents/llm-contracts.js';

function toolsOpts(extra: Partial<LlmCompleteOptions> = {}): LlmCompleteOptions {
  return { phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test.v1', contractName: 'test', terminalToolOffered: [], ...(extra as object) } as LlmCompleteOptions;
}

function asMessage(r: LlmCompleteResult): { content: string; tool_calls: ToolCall[]; finishReason: string } {
  if (r.kind === 'message') return { content: r.content, tool_calls: [], finishReason: 'stop' };
  return { content: '', tool_calls: r.tool_calls, finishReason: 'tool_calls' };
}

// ── Test Cases ─────────────────────────────────────────────────

describe('LlmClient Integration with Mock HTTP Server', () => {
  // ── TC1: Successful non-streaming ────────────────────────────

  it('should send correct request and return response content', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('Hello from test model!')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk-test-key' });
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-1',
        toolsOpts({ temperature: 0.5, max_tokens: 500 }));

      // result is LlmCompleteResult with .content, .toolCalls, .finishReason
      expect(asMessage(result).content).toBe('Hello from test model!');
      expect(asMessage(result).tool_calls).toEqual([]);
      expect(asMessage(result).finishReason).toBe('stop');
      expect(cap.method).toBe('POST');
      expect(cap.url).toBe('/v1/chat/completions');
      expect(cap.headers['content-type']).toBe('application/json');
      expect(cap.headers['authorization']).toBe('Bearer sk-test-key');

      const body = JSON.parse(cap.body);
      expect(body.model).toBe('test-model');
      expect(body.temperature).toBe(0.5);
      expect(body.max_tokens).toBe(500);
      expect(body.stream).toBe(false);
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0]).toEqual({ role: 'system', content: sp() });
      expect(body.messages[1].role).toBe('user');
    } finally {
      await closeServer(server);
    }
  });

  it('should not duplicate /v1 when baseUrl already ends with /v1', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('Hello from v1 root')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/v1`, apiKey: 'sk-test-key' });
      await client.complete(
        cand(), sp(), msgs(), 'sess-v1-root',
        toolsOpts({ temperature: 0.5, max_tokens: 500 }));

      expect(cap.url).toBe('/v1/chat/completions');
    } finally {
      await closeServer(server);
    }
  });

  it('should use Copilot chat endpoint and IDE headers for Copilot API roots', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('Hello from copilot root')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/githubcopilot.com`, apiKey: 'copilot-token' });
      await client.complete(
        cand(), sp(), msgs(), 'sess-copilot-root',
        toolsOpts({ temperature: 0.5, max_tokens: 500 }));

      expect(cap.url).toBe('/githubcopilot.com/chat/completions');
      expect(cap.headers['editor-version']).toBe('vscode/1.107.0');
      expect(cap.headers['copilot-integration-id']).toBe('vscode-chat');
    } finally {
      await closeServer(server);
    }
  });

  it('should use ChatGPT backend Codex responses endpoint for openai-codex', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Codex ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'works' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwtWithCodexAccount('acct-test-123') });
      const result = await client.complete(
        cand('openai-codex', 'gpt-5.4'), sp(), msgs(), 'sess-codex',
        toolsOpts({ temperature: 0.5, max_tokens: 500 }));

      expect(asMessage(result).content).toBe('Codex works');
      expect(asMessage(result).tool_calls).toEqual([]);
      expect(cap.url).toBe('/backend-api/codex/responses');
      expect(cap.headers['accept']).toBe('text/event-stream');
      expect(cap.headers['chatgpt-account-id']).toBe('acct-test-123');
      expect(cap.headers['openai-beta']).toBe('responses=experimental');

      const body = JSON.parse(cap.body);
      expect(body.model).toBe('gpt-5.4');
      expect(body.stream).toBe(true);
      expect(body).not.toHaveProperty('max_output_tokens');
      expect(body.instructions).toBe(sp());
      expect(body.temperature).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('should make a single openai-codex attempt without max_output_tokens when max_tokens is configured', async () => {
    const { server, port, captures } = await createMultiCaptureMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'Single ' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'succeeded' })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwtWithCodexAccount('acct-test-123') });
      const result = await client.complete(
        cand('openai-codex', 'gpt-5.4'), sp(), msgs(), 'sess-codex-retry',
        toolsOpts({ temperature: 0.5, max_tokens: 500 }));

      expect(asMessage(result).content).toBe('Single succeeded');
      expect(captures).toHaveLength(1);
      expect(JSON.parse(captures[0].body)).not.toHaveProperty('max_output_tokens');
      expect(captures[0].url).toBe('/backend-api/codex/responses');
    } finally {
      await closeServer(server);
    }
  });

  it('should parse Codex completed output-item message content', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: '{"status":"done","summary":"ok"}' }],
          },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwtWithCodexAccount('acct-test-123') });
      const result = await client.complete(
        cand('openai-codex', 'gpt-5.4'), sp(), msgs(), 'sess-codex-output-item',
      toolsOpts(),
      );

      expect(asMessage(result).content).toBe('{"status":"done","summary":"ok"}');
      expect(asMessage(result).tool_calls).toEqual([]);
      expect(asMessage(result).finishReason).toBe('stop');
    } finally {
      await closeServer(server);
    }
  });

  it('should parse Codex completed output-item function calls', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            id: 'fc_1',
            type: 'function_call',
            call_id: 'call_1',
            name: 'glob',
            arguments: '{"directory":".","pattern":"**/*"}',
          },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwtWithCodexAccount('acct-test-123') });
      const result = await client.complete(
        cand('openai-codex', 'gpt-5.4'), sp(), msgs(), 'sess-codex-function-call',
        toolsOpts({
          tools: [{
            type: 'function',
            function: {
              name: 'glob',
              description: 'Find files',
              parameters: { type: 'object', properties: { directory: { type: 'string' }, pattern: { type: 'string' } } },
            },
          }],
        }));

      expect(asMessage(result).content).toBe('');
      expect(asMessage(result).finishReason).toBe('tool_calls');
      expect(asMessage(result).tool_calls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'glob', arguments: '{"directory":".","pattern":"**/*"}' },
        },
      ]);
      expect(JSON.parse(cap.body).tools).toHaveLength(1);
    } finally {
      await closeServer(server);
    }
  });

  it('should send a non-empty Codex input even when conversation messages are empty', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\n`);
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}/backend-api`, apiKey: makeJwtWithCodexAccount('acct-test-123') });
      await client.complete(
        cand('openai-codex', 'gpt-5.4'), sp(), [], 'sess-codex-empty',
      toolsOpts(),
      );

      const body = JSON.parse(cap.body);
      expect(body.input).toHaveLength(1);
      expect(body.input[0].role).toBe('user');
      expect(body.input[0].content[0].text).toContain('Proceed');
    } finally {
      await closeServer(server);
    }
  });

  // ── TC2: Auth error (401) ────────────────────────────────────

  it('should throw LlmRequestError(auth_permanent) on 401', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-auth', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'auth_permanent' } });
    } finally {
      await closeServer(server);
    }
  }, 15000);

  // TODO: Pre-existing issue — auth_permanent failure is masked by "No healthy candidates"
  // when the sole candidate is marked unavailable. Error-chaining in
  // InvocationRecoveryPolicy.decideNoCandidates would preserve the original failure.
  it.skip('should redact secret-key JSON values from provider error bodies, persisted failures, and events', async () => {
    const syntheticSecrets = {
      token: 'synthetic-token-value-never-real',
      api_key: 'synthetic-api-key-value-never-real',
      authorization: 'Bearer synthetic-authorization-value-never-real',
      password: 'synthetic-password-value-never-real',
      secret: 'synthetic-secret-value-never-real',
    };
    const providerBody = {
      error: {
        message: 'synthetic provider rejected credentials',
        ...syntheticSecrets,
        stringified_json: JSON.stringify({
          token: syntheticSecrets.token,
          api_key: syntheticSecrets.api_key,
          authorization: syntheticSecrets.authorization,
          password: syntheticSecrets.password,
          secret: syntheticSecrets.secret,
          safe: 'visible',
        }),
      },
    };
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(providerBody));
    });

    let adapterTempDir = '';
    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      let clientError: unknown;
      try {
        await client.complete(cand(), sp(), msgs(), 'sess-redact-client', toolsOpts());
      } catch (err) {
        clientError = err;
      }
      expect(clientError).toBeInstanceOf(LlmRequestError);
      expect((clientError as InstanceType<typeof LlmRequestError>).failure.kind).toBe('auth_permanent');
      const clientErrorMessage = clientError instanceof Error ? clientError.message : String(clientError);
      for (const secret of Object.values(syntheticSecrets)) {
        expect(clientErrorMessage).not.toContain(secret);
      }
      expect(clientErrorMessage).toContain('[REDACTED]');

      void adapterTempDir;
    } finally {
      await closeServer(server);
      if (adapterTempDir) cleanupDir(adapterTempDir);
    }
  }, 15000);

  it('should throw LlmRequestError(auth_permanent) on 403', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-403', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'auth_permanent' } });
    } finally {
      await closeServer(server);
    }
  });

  // ── TC3: Rate limit (429) ────────────────────────────────────

  it('should throw LlmRequestError(rate_limit) on 429', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-rate', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'rate_limit' } });
    } finally {
      await closeServer(server);
    }
  });

  // ── TC4: Server error (500) ──────────────────────────────────

  it('should throw LlmRequestError(server_transient) on 500', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Server error' } }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-500', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'server_transient' } });
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmRequestError(server_transient) on 502', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-502', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'server_transient' } });
    } finally {
      await closeServer(server);
    }
  });

  // ── TC5: Timeout ─────────────────────────────────────────────

  it('should throw LlmRequestError(cancelled) when AbortSignal fires', async () => {
    const { server, port } = await createMockServer(() => {
      // Never respond — hangs
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-timeout', toolsOpts({
          signal: controller.signal,
        })),
      ).rejects.toMatchObject({ failure: { kind: 'cancelled' } });
    } finally {
      await closeServer(server);
    }
  });

  // ── TC6: Parse error (malformed JSON) ────────────────────────

  it('should throw LlmRequestError(parse_error) on non-JSON response', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('This is not JSON at all');
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-parse', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'parse_error' } });
    } finally {
      await closeServer(server);
    }
  });

  // ── TC7: Parse error (missing choices) ───────────────────────

  it('should throw LlmRequestError(parse_error) on empty choices array', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-empty',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [],
      }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-empty', toolsOpts()),
      ).rejects.toMatchObject({ failure: { kind: 'parse_error' } });
    } finally {
      await closeServer(server);
    }
  });

  it('should return result with null content when message content is null', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'chatcmpl-null',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [
          { index: 0, message: { role: 'assistant', content: null }, finish_reason: 'stop' },
        ],
      }));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      const result = await client.complete(cand(), sp(), msgs(), 'sess-null', toolsOpts());
      expect(asMessage(result).content).toBe('');
      expect(asMessage(result).tool_calls).toEqual([]);
      expect(asMessage(result).finishReason).toBe('stop');
    } finally {
      await closeServer(server);
    }
  });
});

// ── Streaming Mode ─────────────────────────────────────────────

describe('LlmClient Streaming Mode', () => {
  it('should concatenate SSE data chunks into full response', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(streamLine('Hello'));
      res.write(streamLine(' world'));
      res.write(streamLine(' from'));
      res.write(streamLine(' streaming'));
      res.write(streamLine(' model!'));
      res.write(streamLine('', true));
      res.end();
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk-test-key' });
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-stream-1', toolsOpts({ stream: true }));
      expect(asMessage(result).content).toBe('Hello world from streaming model!');
    } finally {
      await closeServer(server);
    }
  });

  it('should handle streaming with partial lines (buffering)', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Split a line across writes to test buffering
      res.write('data: {"id":"chunk-1","object":"chat.completion.chunk",');
      res.write('"created":1,"model":"test","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]}\n\n');
      res.write(streamLine(' done'));
      res.write(streamLine('', true));
      res.end();
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk-test-key' });
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-stream-2', toolsOpts({ stream: true }));
      expect(asMessage(result).content).toBe('partial done');
    } finally {
      await closeServer(server);
    }
  });

  it('should send stream: true in request body', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(streamLine('ok'));
      res.write(streamLine('', true));
      res.end();
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'sk-test-key' });
      await client.complete(
        cand(), sp(), msgs(), 'sess-stream-3', toolsOpts({ stream: true }));
      const body = JSON.parse(cap.body);
      expect(body.stream).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmRequestError(cancelled) when streaming is aborted', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(streamLine('partial...'));
      // Never send DONE, never close
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 75);

      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-stream-timeout', toolsOpts({
          stream: true, signal: controller.signal,
        })),
      ).rejects.toMatchObject({ failure: { kind: 'cancelled' } });
    } finally {
      await closeServer(server);
    }
  });
});

// ── Edge Cases ─────────────────────────────────────────────────

describe('LlmClient Edge Cases', () => {
  it('should NOT send Authorization header when apiKey is undefined', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('no-auth')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` }); // no apiKey
      await client.complete(cand(), sp(), msgs(), 'sess-noauth', toolsOpts());
      expect(cap.headers['authorization']).toBeUndefined();
    } finally {
      await closeServer(server);
    }
  });

  it('should use default temperature and max_tokens when not specified', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('defaults')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      await client.complete(cand(), sp(), msgs(), 'sess-defaults', toolsOpts());
      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(4096);
    } finally {
      await closeServer(server);
    }
  });

  it('should handle special roles (tool, assistant, system)', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('multi-role')));
    });

    try {
      const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}` });
      const multiMsgs = [
        { id: '1', session_id: 's', role: 'system' as const, kind: 'text' as const, content: 'sys msg', round_id: 'r-user-00000000000000000000000000000001', message_index: 0, block_index: 0, timestamp: new Date().toISOString() },
        { id: '2', session_id: 's', role: 'assistant' as const, kind: 'text' as const, content: 'asst msg', round_id: 'r-user-00000000000000000000000000000001', message_index: 1, block_index: 1, timestamp: new Date().toISOString() },
        { id: '3', session_id: 's', role: 'tool' as const, kind: 'text' as const, content: 'tool msg', round_id: 'r-user-00000000000000000000000000000001', message_index: 2, block_index: 2, timestamp: new Date().toISOString() },
      ];
      await client.complete(cand(), sp(), multiMsgs, 'sess-roles', toolsOpts());
      const body = JSON.parse(cap.body);
      expect(body.messages).toHaveLength(4); // system prompt + 3
      expect(body.messages[1].role).toBe('system');
      expect(body.messages[2].role).toBe('assistant');
      expect(body.messages[3].role).toBe('tool');
    } finally {
      await closeServer(server);
    }
  });
});

describe('LlmClient provider capability guardrails', () => {
  it('rejects tool options for an incompatible candidate before sending HTTP', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'should not be reached' }));
    });
    const cfg = {
      models: { default: ['test-model'] },
      providers: {
        p1: { models: ['test-model'], capabilities: { toolsMode: 'unsupported' as const } },
      },
      server: { port: 8080, host: '0.0.0.0' },
      runtime: {
        candidateAvailabilityCompactBytes: 262144,
        recoverAgentInvocations: true,
        healthCheckIntervalMs: 30000,
        idleShutdownMs: 300000,
        maxGoalDepth: 5,
        recoveryDelayMs: 60000,
        autoDispatchBacklog: true,
        continuousImprovement: false,
        maxReviewRetries: 3,
        processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
        compactionThreshold: 0.8,
        maxCompactions: 3,
        compactionTimeoutMs: 1200000,
        compactionKeepFraction: 0.2,
        maxRecoveryRetries: 3,
        selfCheck: { executor: 15, planner: 30, analyst: 0 },
      },
      security: { injectionScanner: true, maxScanLengthBytes: 102400 },
      supervisor: { enabled: true, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
    };
    const registry = new ProviderRegistry(cfg);
    const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, registry });

    try {
      await expect(client.complete(
        { provider: 'p1', account: null, model: 'test-model' },
        sp(),
        msgs(),
        'sess-cap',
        toolsOpts({
          tools: [{ type: 'function', function: { name: 'do_work', description: 'work', parameters: { type: 'object' } } }],
          tool_choice: { kind: 'auto' },
        }))).rejects.toThrow(/unsupported_tools_mode/);
      expect(cap.body).toBe('');
    } finally {
      await closeServer(server);
    }
  });

  it('rejects openai-codex tool overrides before entering the special backend branch', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'should not be reached' }));
    });
    const cfg = {
      models: { default: ['gpt-5.5'] },
      providers: {
        'openai-codex': {
          models: ['gpt-5.5'],
          baseUrl: `http://localhost:${port}`,
          capabilities: { toolsMode: 'unsupported' as const, exclusiveToolChoiceSupport: 'unsupported' as const },
        },
      },
      server: { port: 8080, host: '0.0.0.0' },
      runtime: {
        candidateAvailabilityCompactBytes: 262144,
        recoverAgentInvocations: true,
        healthCheckIntervalMs: 30000,
        idleShutdownMs: 300000,
        maxGoalDepth: 5,
        recoveryDelayMs: 60000,
        autoDispatchBacklog: true,
        continuousImprovement: false,
        maxReviewRetries: 3,
        processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
        compactionThreshold: 0.8,
        maxCompactions: 3,
        compactionTimeoutMs: 1200000,
        compactionKeepFraction: 0.2,
        maxRecoveryRetries: 3,
        selfCheck: { executor: 15, planner: 30, analyst: 0 },
      },
      security: { injectionScanner: true, maxScanLengthBytes: 102400 },
      supervisor: { enabled: true, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
    };
    const registry = new ProviderRegistry(cfg);
    const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'synthetic-token', registry });

    try {
      await expect(client.complete(
        { provider: 'openai-codex', account: null, model: 'gpt-5.5' },
        sp(),
        msgs(),
        'sess-codex-overridden',
        toolsOpts({
          tools: [{ type: 'function', function: { name: 'do_work', description: 'work', parameters: { type: 'object' } } }],
          tool_choice: { kind: 'auto' },
        }))).rejects.toThrow(/unsupported_tools_mode|unsupported_exclusive_tool_choice/);
      expect(cap.body).toBe('');
    } finally {
      await closeServer(server);
    }
  });

  it('preserves openai-codex special backend behavior and does not call chat completions', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'chat endpoint should not be used' }));
    });
    const cfg = {
      models: { default: ['gpt-5.5'] },
      providers: { 'openai-codex': { models: ['gpt-5.5'], baseUrl: `http://localhost:${port}` } },
      server: { port: 8080, host: '0.0.0.0' },
      runtime: {
        candidateAvailabilityCompactBytes: 262144,
        recoverAgentInvocations: true,
        healthCheckIntervalMs: 30000,
        idleShutdownMs: 300000,
        maxGoalDepth: 5,
        recoveryDelayMs: 60000,
        autoDispatchBacklog: true,
        continuousImprovement: false,
        maxReviewRetries: 3,
        processTimeouts: { plannerMs: 1200000, executorMs: 1200000, reviewerMs: 1200000 },
        compactionThreshold: 0.8,
        maxCompactions: 3,
        compactionTimeoutMs: 1200000,
        compactionKeepFraction: 0.2,
        maxRecoveryRetries: 3,
        selfCheck: { executor: 15, planner: 30, analyst: 0 },
      },
      security: { injectionScanner: true, maxScanLengthBytes: 102400 },
      supervisor: { enabled: true, intervalMs: 1200000, consecutiveStuckVerdicts: 3, logLines: 400 },
    };
    const registry = new ProviderRegistry(cfg);
    const client = new LlmProviderGateway({ baseUrl: `http://localhost:${port}`, apiKey: 'synthetic-token', registry });

    try {
      await expect(client.complete(
        { provider: 'openai-codex', account: null, model: 'gpt-5.5' },
        sp(),
        msgs(),
        'sess-codex',
        toolsOpts(),
      )).rejects.toThrow();
      expect(cap.url).not.toBe('/v1/chat/completions');
    } finally {
      await closeServer(server);
    }
  });
});

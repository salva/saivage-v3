/**
 * Integration tests for LlmClient → AgentAdapter.createLlmCallFn() →
 * config → router → mock HTTP server round-trip.
 *
 * Uses node:http mock servers to verify:
 * - Successful non-streaming round-trip
 * - Auth error (401)
 * - Rate limit (429)
 * - Server error (500)
 * - Timeout (AbortSignal)
 * - Parse error (malformed JSON, missing choices)
 * - Adapter + Router full flow
 * - Streaming mode (SSE)
 * - Account-level config overrides
 * - Config temperature/max_tokens flow through AgentAdapter
 */

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

// ── Dynamic imports ────────────────────────────────────────────

let LlmProviderGateway: typeof import('../../src/agents/llm-provider-gateway.js').LlmProviderGateway;
let LlmRequestError: typeof import('../../src/agents/llm-failure.js').LlmRequestError;

let AgentAdapter: typeof import('../../src/agents/agent-adapter.js').AgentAdapter;
let createAgentAdapter: typeof import('../../src/agents/agent-adapter.js').createAgentAdapter;

let ProviderRegistry: typeof import('../../src/agents/provider.js').ProviderRegistry;
let ModelRouter: typeof import('../../src/agents/model-router.js').ModelRouter;
let resolveLlmTransportConfig: typeof import('../../src/agents/llm-transport.js').resolveLlmTransportConfig;

let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;

beforeAll(async () => {
  const gatewayMod = await import('../../src/agents/llm-provider-gateway.js');
  const failureMod = await import('../../src/agents/llm-failure.js');
  LlmProviderGateway = gatewayMod.LlmProviderGateway;
  LlmRequestError = failureMod.LlmRequestError;

  const adapterMod = await import('../../src/agents/agent-adapter.js');
  AgentAdapter = adapterMod.AgentAdapter;
  createAgentAdapter = adapterMod.createAgentAdapter;

  ProviderRegistry = (await import('../../src/agents/provider.js')).ProviderRegistry;
  ModelRouter = (await import('../../src/agents/model-router.js')).ModelRouter;
  resolveLlmTransportConfig = (await import('../../src/agents/llm-transport.js')).resolveLlmTransportConfig;
  loadConfig = (await import('../../src/agents/config-schema.js')).loadConfig;
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

function writeSaivageJson(projectRoot: string, json: Record<string, unknown>): void {
  writeFileSync(
    join(projectRoot, '.saivage', 'saivage.json'),
    JSON.stringify(json, null, 2),
    'utf-8',
  );
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
        { temperature: 0.5, max_tokens: 500 },
      );

      // result is LlmCompleteResult with .content, .toolCalls, .finishReason
      expect(result.content).toBe('Hello from test model!');
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe('stop');
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
        { temperature: 0.5, max_tokens: 500 },
      );

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
        { temperature: 0.5, max_tokens: 500 },
      );

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
        { temperature: 0.5, max_tokens: 500 },
      );

      expect(result.content).toBe('Codex works');
      expect(result.toolCalls).toEqual([]);
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
        { temperature: 0.5, max_tokens: 500 },
      );

      expect(result.content).toBe('Single succeeded');
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
      );

      expect(result.content).toBe('{"status":"done","summary":"ok"}');
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe('stop');
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
            name: 'list_project_files',
            arguments: '{"path":"."}',
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
        {
          tools: [{
            type: 'function',
            function: {
              name: 'list_project_files',
              description: 'List files',
              parameters: { type: 'object', properties: { path: { type: 'string' } } },
            },
          }],
        },
      );

      expect(result.content).toBeNull();
      expect(result.finishReason).toBe('tool_calls');
      expect(result.toolCalls).toEqual([
        {
          id: 'call_1',
          type: 'function',
          function: { name: 'list_project_files', arguments: '{"path":"."}' },
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
        client.complete(cand(), sp(), msgs(), 'sess-auth'),
      ).rejects.toMatchObject({ failure: { kind: 'auth_permanent' } });
    } finally {
      await closeServer(server);
    }
  }, 15000);

  it('should redact secret-key JSON values from provider error bodies, persisted failures, and events', async () => {
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
        await client.complete(cand(), sp(), msgs(), 'sess-redact-client');
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

      adapterTempDir = makeTempDir();
      writeSaivageJson(adapterTempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'synthetic-adapter-key',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });
      const events = new EventEmitter();
      const failures: unknown[] = [];
      events.on('invocation_failed', (event) => failures.push(event));
      const adapter = createAgentAdapter(adapterTempDir, events);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      await expect(
        adapter.invokePlanner('goal-1', sp(), msgs()),
      ).rejects.toMatchObject({ failure: { kind: 'auth_permanent' } });

      const agentsDir = join(adapterTempDir, '.saivage', 'agents');
      const readPersisted = (dir: string): string => {
        if (!existsSync(dir)) return '';
        return readdirSync(dir).map((entry) => {
          const fullPath = join(dir, entry);
          return statSync(fullPath).isDirectory() ? readPersisted(fullPath) : readFileSync(fullPath, 'utf-8');
        }).join('\\n');
      };
      const persisted = readPersisted(agentsDir);
      const serializedFailures = JSON.stringify(failures);
      for (const secret of Object.values(syntheticSecrets)) {
        expect(persisted).not.toContain(secret);
        expect(serializedFailures).not.toContain(secret);
      }
      expect(persisted).toContain('[REDACTED]');
      expect(serializedFailures).toContain('[REDACTED]');
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
        client.complete(cand(), sp(), msgs(), 'sess-403'),
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
        client.complete(cand(), sp(), msgs(), 'sess-rate'),
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
        client.complete(cand(), sp(), msgs(), 'sess-500'),
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
        client.complete(cand(), sp(), msgs(), 'sess-502'),
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
        client.complete(cand(), sp(), msgs(), 'sess-timeout', {
          signal: controller.signal,
        }),
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
        client.complete(cand(), sp(), msgs(), 'sess-parse'),
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
        client.complete(cand(), sp(), msgs(), 'sess-empty'),
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
      const result = await client.complete(cand(), sp(), msgs(), 'sess-null');
      expect(result.content).toBeNull();
      expect(result.toolCalls).toEqual([]);
      expect(result.finishReason).toBe('stop');
    } finally {
      await closeServer(server);
    }
  });
});

// ── Adapter + Router Integration ───────────────────────────────

describe('AgentAdapter + Router + LlmClient Full Integration', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupDir(tempDir);
  });

  it('should flow config → router → adapter → llmCallFn → response → parsing', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(JSON.stringify({
        created_cards: [
          {
            type: 'code',
            title: 'Add auth middleware',
            description: 'Implement auth',
            status: 'backlog',
            depends_on: [],
            priority: 1,
          },
        ],
        updated_cards: [],
        status: 'continue',
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-integration-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const { config } = loadConfig(tempDir);
      const saivageDir = join(tempDir, '.saivage');
      const adapter = new AgentAdapter({ projectRoot: tempDir, saivageDir, config });

      // Verify router resolves candidates
      const registry = new ProviderRegistry(config);
      const router = new ModelRouter(config, registry);
      const candidates = await router.resolve('planner');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].provider).toBe('test-provider');
      expect(candidates[0].model).toBe('test-model');

      // Wire and invoke
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      const result = await adapter.invokePlanner(
        'goal-1', sp(), msgs(),
      );

      expect(result.created_cards).toHaveLength(1);
      expect(result.created_cards[0].title).toBe('Add auth middleware');
      expect(result.created_cards[0].type).toBe('code');
      expect(result.status).toBe('continue');
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should emit one success and no failed event when Codex max_tokens is configured', async () => {
    const { server, port, captures } = await createMultiCaptureMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.end([
        `data: ${JSON.stringify({
          type: 'response.output_item.done',
          item: {
            type: 'message',
            content: [{ type: 'output_text', text: JSON.stringify({ created_cards: [], updated_cards: [], status: 'continue' }) }],
          },
        })}\n\n`,
        `data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed' } })}\n\n`,
        'data: [DONE]\n\n',
      ].join(''));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['gpt-5.4'], max_tokens: { planner: 500 } },
        providers: {
          'openai-codex': {
            priority: 10,
            models: ['gpt-5.4'],
            baseUrl: `http://localhost:${port}/backend-api`,
            apiKey: makeJwtWithCodexAccount('acct-test-123'),
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const events = new EventEmitter();
      const successes: unknown[] = [];
      const failures: unknown[] = [];
      events.on('invocation_succeeded', (event) => successes.push(event));
      events.on('invocation_failed', (event) => failures.push(event));

      const adapter = createAgentAdapter(tempDir, events);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      const result = await adapter.invokePlanner('goal-codex-retry', sp(), msgs());

      expect(result.status).toBe('continue');
      expect(captures).toHaveLength(1);
      expect(JSON.parse(captures[0].body)).not.toHaveProperty('max_output_tokens');
      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(0);
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should invoke executor through adapter with mock server', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(JSON.stringify({
        card_id: 'code-1',
        status: 'done',
        status_text: 'Executor completed successfully',
        artifacts: [{ type: 'report', description: 'Test results', retain: true }],
        attachments: [],
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      const result = await adapter.invokeExecutor(
        'code-1', 'goal-1', sp(), msgs(),
      );

      expect(result.status).toBe('done');
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].type).toBe('report');
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should propagate provider errors through adapter', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      await expect(
        adapter.invokePlanner('goal-1', sp(), msgs()),
      ).rejects.toThrow();
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  }, 15000);
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
        cand(), sp(), msgs(), 'sess-stream-1', { stream: true },
      );
      expect(result.content).toBe('Hello world from streaming model!');
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
        cand(), sp(), msgs(), 'sess-stream-2', { stream: true },
      );
      expect(result.content).toBe('partial done');
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
        cand(), sp(), msgs(), 'sess-stream-3', { stream: true },
      );
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
        client.complete(cand(), sp(), msgs(), 'sess-stream-timeout', {
          stream: true, signal: controller.signal,
        }),
      ).rejects.toMatchObject({ failure: { kind: 'cancelled' } });
    } finally {
      await closeServer(server);
    }
  });
});

// ── Account-level Config Overrides ─────────────────────────────

describe('Account-level Provider Config Overrides', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupDir(tempDir);
  });

  it('should use account-level baseUrl and apiKey when configured', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(JSON.stringify({
        created_cards: [],
        updated_cards: [],
        status: 'continue',
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: 'http://should-be-overridden',
            apiKey: 'sk-provider-level',
            accounts: {
              primary: {
                priority: 10,
                baseUrl: `http://localhost:${port}`,
                apiKey: 'sk-account-level',
              },
            },
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      const result = await adapter.invokePlanner(
        'goal-1', sp(), msgs(),
      );

      expect(result.created_cards).toBeDefined();
      expect(cap.headers['authorization']).toBe('Bearer sk-account-level');
      // Verify it hit our mock server (not the overridden URL)
      expect(cap.url).toBe('/v1/chat/completions');
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should fall back to provider baseUrl/apiKey when account has none', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(JSON.stringify({
        created_cards: [],
        updated_cards: [],
        status: 'continue',
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-provider-level',
            accounts: {
              primary: { priority: 10 },
            },
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      await adapter.invokePlanner(
        'goal-1', sp(), msgs(),
      );

      expect(cap.headers['authorization']).toBe('Bearer sk-provider-level');
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should use project auth profile token when no static apiKey is configured', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(JSON.stringify({
        created_cards: [],
        updated_cards: [],
        status: 'continue',
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            authProfile: 'test-oauth',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });
      writeFileSync(
        join(tempDir, '.saivage', 'auth-profiles.json'),
        JSON.stringify({
          version: 1,
          profiles: {
            'test-oauth': {
              type: 'oauth',
              provider: 'test-provider',
              access: 'oauth-access-token',
            },
          },
        }),
        'utf-8',
      );

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());

      await adapter.invokePlanner(
        'goal-1', sp(), msgs(),
      );

      expect(cap.headers['authorization']).toBe('Bearer oauth-access-token');
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  it('should use built-in OpenCode base URLs when config omits baseUrl', async () => {
    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'opencode-go': {
            priority: 10,
            models: ['test-model'],
            apiKey: 'sk-opencode-go',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      const candidates = await adapter.router.resolve('planner');
      const candidate = candidates[0];
      expect(candidate.provider).toBe('opencode-go');

      const transport = await resolveLlmTransportConfig(
        tempDir,
        adapter.registry,
        candidate,
      );

      expect(transport.baseUrl).toBe('https://opencode.ai/zen/go/v1');
      expect(transport.apiKey).toBe('sk-opencode-go');
    } finally {
      if (tempDir) cleanupDir(tempDir);
    }
  });
});

// ── Config temperature/max_tokens flow through AgentAdapter ──────

describe('Config temperature/max_tokens flowing through AgentAdapter', () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) cleanupDir(tempDir);
  });

  // Shared planner result that parses cleanly
  function plannerContent() {
    return JSON.stringify({
      created_cards: [],
      updated_cards: [],
      status: 'done',
    });
  }

  // ── TC1: Default temperature (0.7) and max_tokens (4096) ─────

  it('should send default temperature 0.7 and max_tokens 4096 when not overridden in config', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(plannerContent())));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { default: ['test-model'] },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      await adapter.invokePlanner('goal-tc1', sp(), msgs());

      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.7);
      expect(body.max_tokens).toBe(4096);
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  // ── TC2: Per-role temperature override ──────────────────────

  it('should send per-role temperature override when models.temperature.planner is set', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(plannerContent())));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: {
          default: ['test-model'],
          temperature: { planner: 0.3 },
          max_tokens: { planner: 2000 },
        },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      await adapter.invokePlanner('goal-tc2', sp(), msgs());

      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.3);
      expect(body.max_tokens).toBe(2000);
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  // ── TC3: Per-role max_tokens override with default temperature ──

  it('should send per-role max_tokens override and fall back to default temperature', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(plannerContent())));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: {
          default: ['test-model'],
          temperature: { default: 0.5 },
          max_tokens: { planner: 8192 },
        },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      await adapter.invokePlanner('goal-tc3', sp(), msgs());

      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.5);   // from models.default
      expect(body.max_tokens).toBe(8192);   // from per-role planner
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  // ── TC4: models.default fallback ────────────────────────────

  it('should use models.default temperature and max_tokens when no per-role values', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(plannerContent())));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: {
          default: ['test-model'],
          temperature: { default: 0.2 },
          max_tokens: { default: 1000 },
        },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      await adapter.invokePlanner('goal-tc4', sp(), msgs());

      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.2);
      expect(body.max_tokens).toBe(1000);
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
    }
  });

  // ── TC5: Full fallback chain (role overrides default) ───────

  it('should use per-role temp and default max_tokens when role overrides only temperature', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp(plannerContent())));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: {
          default: ['test-model'],
          temperature: { planner: 0.1 },
          max_tokens: { default: 2048 },
        },
        providers: {
          'test-provider': {
            priority: 10,
            models: ['test-model'],
            baseUrl: `http://localhost:${port}`,
            apiKey: 'sk-test',
          },
        },
        runtime: { recoveryDelayMs: 10, maxRecoveryRetries: 0 },
      });

      const adapter = createAgentAdapter(tempDir);
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      await adapter.invokePlanner('goal-tc5', sp(), msgs());

      const body = JSON.parse(cap.body);
      expect(body.temperature).toBe(0.1);    // from per-role planner
      expect(body.max_tokens).toBe(2048);    // from models.default
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
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
      await client.complete(cand(), sp(), msgs(), 'sess-noauth');
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
      await client.complete(cand(), sp(), msgs(), 'sess-defaults');
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
      await client.complete(cand(), sp(), multiMsgs, 'sess-roles');
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
        p1: { models: ['test-model'], capabilities: { toolCalls: 'none' as const } },
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
        {
          tools: [{ type: 'function', function: { name: 'do_work', description: 'work', parameters: { type: 'object' } } }],
          tool_choice: 'auto',
        },
      )).rejects.toThrow(/unsupported_tool_calls/);
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
          capabilities: { toolCalls: 'none' as const, toolChoice: 'none' as const },
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
        {
          tools: [{ type: 'function', function: { name: 'do_work', description: 'work', parameters: { type: 'object' } } }],
          tool_choice: 'auto',
        },
      )).rejects.toThrow(/unsupported_tool_calls|unsupported_tool_choice/);
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
      )).rejects.toThrow();
      expect(cap.url).not.toBe('/v1/chat/completions');
    } finally {
      await closeServer(server);
    }
  });
});

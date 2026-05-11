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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── Dynamic imports ────────────────────────────────────────────

let LlmClient: typeof import('../../src/agents/llm-client.js').LlmClient;
let LlmAuthError: typeof import('../../src/agents/llm-client.js').LlmAuthError;
let LlmRateLimitError: typeof import('../../src/agents/llm-client.js').LlmRateLimitError;
let LlmServerError: typeof import('../../src/agents/llm-client.js').LlmServerError;
let LlmTimeoutError: typeof import('../../src/agents/llm-client.js').LlmTimeoutError;
let LlmParseError: typeof import('../../src/agents/llm-client.js').LlmParseError;

let AgentAdapter: typeof import('../../src/agents/agent-adapter.js').AgentAdapter;
let createAgentAdapter: typeof import('../../src/agents/agent-adapter.js').createAgentAdapter;

let ProviderRegistry: typeof import('../../src/agents/provider.js').ProviderRegistry;
let ModelRouter: typeof import('../../src/agents/model-router.js').ModelRouter;

let loadConfig: typeof import('../../src/agents/config-schema.js').loadConfig;

beforeAll(async () => {
  const llmMod = await import('../../src/agents/llm-client.js');
  LlmClient = llmMod.LlmClient;
  LlmAuthError = llmMod.LlmAuthError;
  LlmRateLimitError = llmMod.LlmRateLimitError;
  LlmServerError = llmMod.LlmServerError;
  LlmTimeoutError = llmMod.LlmTimeoutError;
  LlmParseError = llmMod.LlmParseError;

  const adapterMod = await import('../../src/agents/agent-adapter.js');
  AgentAdapter = adapterMod.AgentAdapter;
  createAgentAdapter = adapterMod.createAgentAdapter;

  ProviderRegistry = (await import('../../src/agents/provider.js')).ProviderRegistry;
  ModelRouter = (await import('../../src/agents/model-router.js')).ModelRouter;
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

// ── Test Cases ─────────────────────────────────────────────────

describe('LlmClient Integration with Mock HTTP Server', () => {
  // ── TC1: Successful non-streaming ────────────────────────────

  it('should send correct request and return response content', async () => {
    const { server, port, cap } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(okResp('Hello from test model!')));
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`, 'sk-test-key');
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-1',
        { temperature: 0.5, max_tokens: 500 },
      );

      expect(result).toBe('Hello from test model!');
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

  // ── TC2: Auth error (401) ────────────────────────────────────

  it('should throw LlmAuthError on 401', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid API key' } }));
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-auth'),
      ).rejects.toThrow(LlmAuthError);
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmAuthError on 403', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-403'),
      ).rejects.toThrow(LlmAuthError);
    } finally {
      await closeServer(server);
    }
  });

  // ── TC3: Rate limit (429) ────────────────────────────────────

  it('should throw LlmRateLimitError on 429', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Rate limited' } }));
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-rate'),
      ).rejects.toThrow(LlmRateLimitError);
    } finally {
      await closeServer(server);
    }
  });

  // ── TC4: Server error (500) ──────────────────────────────────

  it('should throw LlmServerError on 500', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Server error' } }));
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-500'),
      ).rejects.toThrow(LlmServerError);
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmServerError on 502', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
      res.end('Bad Gateway');
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-502'),
      ).rejects.toThrow(LlmServerError);
    } finally {
      await closeServer(server);
    }
  });

  // ── TC5: Timeout ─────────────────────────────────────────────

  it('should throw LlmTimeoutError when AbortSignal fires', async () => {
    const { server, port } = await createMockServer(() => {
      // Never respond — hangs
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 50);

      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-timeout', {
          signal: controller.signal,
        }),
      ).rejects.toThrow(LlmTimeoutError);
    } finally {
      await closeServer(server);
    }
  });

  // ── TC6: Parse error (malformed JSON) ────────────────────────

  it('should throw LlmParseError on non-JSON response', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('This is not JSON at all');
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-parse'),
      ).rejects.toThrow(LlmParseError);
    } finally {
      await closeServer(server);
    }
  });

  // ── TC7: Parse error (missing choices) ───────────────────────

  it('should throw LlmParseError on empty choices array', async () => {
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
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-empty'),
      ).rejects.toThrow(LlmParseError);
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmParseError when message content is null', async () => {
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
      const client = new LlmClient(`http://localhost:${port}`);
      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-null'),
      ).rejects.toThrow(LlmParseError);
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
        declare_done: false,
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { planner: ['test-model'], default: ['test-model'] },
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
      const candidates = router.resolve('planner');
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[0].provider).toBe('test-provider');
      expect(candidates[0].model).toBe('test-model');

      // Wire and invoke
      adapter.setLlmCallFn(adapter.createLlmCallFn());
      const result = await adapter.invokePlanner(
        'goal-1', 'plan-1', sp(), msgs(),
      );

      expect(result.created_cards).toHaveLength(1);
      expect(result.created_cards[0].title).toBe('Add auth middleware');
      expect(result.created_cards[0].type).toBe('code');
      expect(result.declare_done).toBe(false);
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
        artifacts: [{ type: 'report', description: 'Test results', retain: true }],
        attachments: [],
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { executor: ['test-model'], default: ['test-model'] },
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
        models: { planner: ['test-model'], default: ['test-model'] },
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
        adapter.invokePlanner('goal-1', 'plan-1', sp(), msgs()),
      ).rejects.toThrow();
    } finally {
      await closeServer(server);
      if (tempDir) cleanupDir(tempDir);
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
      const client = new LlmClient(`http://localhost:${port}`, 'sk-test-key');
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-stream-1', { stream: true },
      );
      expect(result).toBe('Hello world from streaming model!');
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
      const client = new LlmClient(`http://localhost:${port}`, 'sk-test-key');
      const result = await client.complete(
        cand(), sp(), msgs(), 'sess-stream-2', { stream: true },
      );
      expect(result).toBe('partial done');
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
      const client = new LlmClient(`http://localhost:${port}`, 'sk-test-key');
      await client.complete(
        cand(), sp(), msgs(), 'sess-stream-3', { stream: true },
      );
      const body = JSON.parse(cap.body);
      expect(body.stream).toBe(true);
    } finally {
      await closeServer(server);
    }
  });

  it('should throw LlmTimeoutError when streaming is aborted', async () => {
    const { server, port } = await createMockServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write(streamLine('partial...'));
      // Never send DONE, never close
    });

    try {
      const client = new LlmClient(`http://localhost:${port}`);
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 75);

      await expect(
        client.complete(cand(), sp(), msgs(), 'sess-stream-timeout', {
          stream: true, signal: controller.signal,
        }),
      ).rejects.toThrow(LlmTimeoutError);
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
        declare_done: false,
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { planner: ['test-model'], default: ['test-model'] },
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
        'goal-1', 'plan-1', sp(), msgs(),
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
        declare_done: false,
      }))));
    });

    try {
      tempDir = makeTempDir();
      writeSaivageJson(tempDir, {
        models: { planner: ['test-model'], default: ['test-model'] },
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
        'goal-1', 'plan-1', sp(), msgs(),
      );

      expect(cap.headers['authorization']).toBe('Bearer sk-provider-level');
    } finally {
      await closeServer(server);
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
      declare_done: true,
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
        models: { planner: ['test-model'], default: ['test-model'] },
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
      await adapter.invokePlanner('goal-tc1', 'plan-tc1', sp(), msgs());

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
          planner: ['test-model'],
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
      await adapter.invokePlanner('goal-tc2', 'plan-tc2', sp(), msgs());

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
          planner: ['test-model'],
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
      await adapter.invokePlanner('goal-tc3', 'plan-tc3', sp(), msgs());

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
          planner: ['test-model'],
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
      await adapter.invokePlanner('goal-tc4', 'plan-tc4', sp(), msgs());

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
          planner: ['test-model'],
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
      await adapter.invokePlanner('goal-tc5', 'plan-tc5', sp(), msgs());

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
      const client = new LlmClient(`http://localhost:${port}`); // no apiKey
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
      const client = new LlmClient(`http://localhost:${port}`);
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
      const client = new LlmClient(`http://localhost:${port}`);
      const multiMsgs = [
        { id: '1', session_id: 's', role: 'system' as const, kind: 'text' as const, content: 'sys msg', timestamp: new Date().toISOString() },
        { id: '2', session_id: 's', role: 'assistant' as const, kind: 'text' as const, content: 'asst msg', timestamp: new Date().toISOString() },
        { id: '3', session_id: 's', role: 'tool' as const, kind: 'text' as const, content: 'tool msg', timestamp: new Date().toISOString() },
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

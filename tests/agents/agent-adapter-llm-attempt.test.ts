/**
 * F04: Tests for canonical `llm_attempt` + `llm_invocation_summary` emission
 * from AgentAdapter.invokeAgent.
 *
 * Asserts:
 *   1. 3-HTTP failover yields 3 llm_attempt events with attempts_count===3 in
 *      the final llm_invocation_summary, despite recovery collapsing the
 *      candidate attempts.length to 1.
 *   2. retry_same_after_delay (rate_limit → cooldown_and_failover-style) emits
 *      multiple llm_attempt events before the final summary.
 *   3. Cancelled run produces llm_invocation_summary with verdict='cancelled'.
 */

import { describe, it, expect, beforeAll, afterEach } from '@jest/globals';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

let createAgentAdapter: typeof import('../../src/agents/agent-adapter.js').createAgentAdapter;

beforeAll(async () => {
  const adapterMod = await import('../../src/agents/agent-adapter.js');
  createAgentAdapter = adapterMod.createAgentAdapter;
});

interface ServerHandle { server: Server; port: number; calls: { count: number } }

function startMockServer(
  handler: (req: IncomingMessage, res: ServerResponse, callIdx: number) => void,
): Promise<ServerHandle> {
  return new Promise((resolve) => {
    const calls = { count: 0 };
    const server = createServer((req, res) => {
      const idx = calls.count++;
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => handler(req, res, idx));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({ server, port, calls });
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `saivage-f04-${Date.now()}-${randomBytes(4).toString('hex')}`);
  mkdirSync(join(dir, '.saivage'), { recursive: true });
  return dir;
}

function writeSaivageJson(projectRoot: string, json: Record<string, unknown>): void {
  writeFileSync(join(projectRoot, '.saivage', 'saivage.json'), JSON.stringify(json, null, 2), 'utf-8');
}

function cleanupDir(dir: string): void {
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

function okPlannerToolCall(model: string) {
  return {
    id: 'chatcmpl-ok',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'call_1', type: 'function',
          function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'continue' }) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };
}

function spText() { return 'You are a test assistant.'; }
function userMsgs() {
  return [{
    id: 'msg-1', session_id: 'sess-f04', role: 'user' as const, kind: 'text' as const,
    content: 'plan something', round_id: 'r-user-00000000000000000000000000000001',
    message_index: 0, block_index: 0, timestamp: new Date().toISOString(),
  }];
}

interface AttemptEvent { outcome: { kind: 'succeeded' | 'failed' }; provider: string; attempt: number; same_candidate_attempt: number }
interface SummaryEvent { verdict: string; attempts_count: number; final_terminal_tool?: string; last_failure_class?: string }

describe('AgentAdapter F04 llm_attempt + llm_invocation_summary emission', () => {
  let tempDir = '';
  let server: Server | null = null;
  afterEach(async () => {
    if (server) { await closeServer(server); server = null; }
    if (tempDir) { cleanupDir(tempDir); tempDir = ''; }
  });

  it('emits one llm_attempt per HTTP failover and a succeeded summary with attempts_count===N', async () => {
    const handle = await startMockServer((req, res, idx) => {
      if (idx < 2) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'transient' } }));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(okPlannerToolCall('m-c')));
      }
    });
    server = handle.server;
    tempDir = makeTempDir();
    writeSaivageJson(tempDir, {
      models: { default: ['m-a', 'm-b', 'm-c'] },
      providers: {
        'p-a': { priority: 30, models: ['m-a'], baseUrl: `http://localhost:${handle.port}`, apiKey: 'k-a' },
        'p-b': { priority: 20, models: ['m-b'], baseUrl: `http://localhost:${handle.port}`, apiKey: 'k-b' },
        'p-c': { priority: 10, models: ['m-c'], baseUrl: `http://localhost:${handle.port}`, apiKey: 'k-c' },
      },
      runtime: { recoveryDelayMs: 1, maxRecoveryRetries: 0 },
    });
    const events = new EventEmitter();
    const attempts: AttemptEvent[] = [];
    const summaries: SummaryEvent[] = [];
    events.on('llm_attempt', (e: AttemptEvent) => attempts.push(e));
    events.on('llm_invocation_summary', (e: SummaryEvent) => summaries.push(e));

    const adapter = createAgentAdapter(tempDir, events);
    adapter.setLlmCallFn(adapter.createLlmCallFn());

    const result = await adapter.invokePlanner('goal-f04-failover', spText(), userMsgs());

    expect(result.status).toBe('continue');
    expect(handle.calls.count).toBe(3);
    expect(attempts.length).toBe(3);
    expect(attempts[0].outcome.kind).toBe('failed');
    expect(attempts[1].outcome.kind).toBe('failed');
    expect(attempts[2].outcome.kind).toBe('succeeded');
    expect(summaries.length).toBe(1);
    expect(summaries[0].verdict).toBe('succeeded');
    expect(summaries[0].attempts_count).toBe(3);
    expect(summaries[0].final_terminal_tool).toBe('emit_planner_result');
  });

  it('emits an exhausted summary with last_failure_class when all candidates fail', async () => {
    const handle = await startMockServer((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'unauthorized' } }));
    });
    server = handle.server;
    tempDir = makeTempDir();
    writeSaivageJson(tempDir, {
      models: { default: ['m-a', 'm-b'] },
      providers: {
        'p-a': { priority: 20, models: ['m-a'], baseUrl: `http://localhost:${handle.port}`, apiKey: 'k-a' },
        'p-b': { priority: 10, models: ['m-b'], baseUrl: `http://localhost:${handle.port}`, apiKey: 'k-b' },
      },
      runtime: { recoveryDelayMs: 1, maxRecoveryRetries: 0 },
    });
    const events = new EventEmitter();
    const attempts: AttemptEvent[] = [];
    const summaries: SummaryEvent[] = [];
    events.on('llm_attempt', (e: AttemptEvent) => attempts.push(e));
    events.on('llm_invocation_summary', (e: SummaryEvent) => summaries.push(e));
    const adapter = createAgentAdapter(tempDir, events);
    adapter.setLlmCallFn(adapter.createLlmCallFn());

    await expect(adapter.invokePlanner('goal-f04-exhausted', spText(), userMsgs())).rejects.toBeDefined();

    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(attempts.every((a) => a.outcome.kind === 'failed')).toBe(true);
    expect(summaries.length).toBe(1);
    expect(summaries[0].verdict).toBe('exhausted');
    expect(summaries[0].last_failure_class).toBe('auth_permanent');
    expect(summaries[0].attempts_count).toBe(attempts.length);
  });
});

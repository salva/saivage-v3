import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createNetServer } from 'node:net';
import { startApp, type App } from '../../src/boot/app.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import * as YAML from 'yaml';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';

let projectRoot: string;
let app: App;

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to reserve an ephemeral test port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

beforeEach(async () => {
  projectRoot = mkdtempSync(join(tmpdir(), 'saivage-operator-api-contract-'));
  initProjectTree(projectRoot);
  const port = await availablePort();
  writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), YAML.stringify({ models: { default: ['test-model'], max_tokens: { analyst: 200 } }, providers: { test: { models: ['test-model'] } }, compaction: { enabled: true, input_budget_tokens: 1000, summarizer_candidate: { provider: 'test', account: null, model: 'test-model' } }, card_processes: DEFAULT_CARD_PROCESSES, runtime: { continuous_improvement: false }, server: { host: '127.0.0.1', port } }));
  app = await startApp({
    argv: ['node', 'test', 'start', '--project-root', projectRoot],
    env: { ...process.env, NODE_ENV: 'test', LOG_LEVEL: 'silent', SAIVAGE_API_TOKEN: undefined },
  });
});

afterEach(async () => {
  const report = await app.stop();
  expect(report).toEqual({ warnings: [] });
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('operator API response contracts', () => {
  it('exposes liveness without runtime internals', async () => {
    const response = await app.server.fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok', version: '0.1.0', project: 'saivage-v3' });
  });

  it('exposes readiness and server availability', async () => {
    const response = await app.server.fastify.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', serverAvailability: expect.any(Object) });
  });

  it('projects process-local runtime without traversing the card inventory', async () => {
    const store = app.server.runtimeApplication.cardStore;
    const list = jest.spyOn(store, 'list');
    const listChildren = jest.spyOn(store, 'listChildren');
    const ancestors = jest.spyOn(store, 'getAncestors');
    const history = jest.spyOn(store, 'listCardHistory');
    const response = await app.server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectRoot,
      projectId: expect.any(String),
      runtime: expect.any(Object),
    });
    expect(response.json()).not.toHaveProperty('cardIndex');
    const status = await app.server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ currentCardId: null, pid: process.pid, started_at: expect.any(String) });
    expect(list).not.toHaveBeenCalled();
    expect(listChildren).not.toHaveBeenCalled();
    expect(ancestors).not.toHaveBeenCalled();
    expect(history).not.toHaveBeenCalled();
  });

  it('serves root hierarchy and detail as separate resources', async () => {
    const hierarchy = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project/children' });
    expect(hierarchy.statusCode).toBe(200);
    expect(hierarchy.json()).toMatchObject({ card: { id: 'project' }, children: [] });
    expect(hierarchy.json().card).not.toHaveProperty('logical_path');
    const detail = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project' });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({ card: { id: 'project' } });
    expect(detail.json()).not.toHaveProperty('children');
    expect((await app.server.fastify.inject({ method: 'GET', url: '/api/cards' })).statusCode).toBe(404);
  });

  it('rejects noncanonical history sequence syntax before card persistence reads', async () => {
    const stream = cardStreamFile(projectRoot, 'project');
    writeFileSync(stream, `${readFileSync(stream, 'utf8')}{complete-malformed}\n`);
    for (const seq of ['0', '+1', '-1', '1.0', '1suffix', '01', '1e2', '9007199254740992']) {
      const response = await app.server.fastify.inject({ method: 'GET', url: `/api/cards/project/history/${encodeURIComponent(seq)}` });
      expect(response.statusCode).toBe(400);
    }
    for (const from of ['0', '+1', '-1', '1.0', '1suffix', '01', '1e2', '9007199254740992']) {
      const response = await app.server.fastify.inject({ method: 'GET', url: `/api/cards/project/diff?from=${encodeURIComponent(from)}` });
      expect(response.statusCode).toBe(400);
      const toResponse = await app.server.fastify.inject({ method: 'GET', url: `/api/cards/project/diff?to=${encodeURIComponent(from)}` });
      expect(toResponse.statusCode).toBe(400);
    }
  });

  it('returns exact typed card-history absence variants', async () => {
    const target = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/card-a/history' });
    expect(target.statusCode).toBe(404);
    expect(target.json()).toEqual({ error: 'Card not found', cardId: 'card-a' });
    const entry = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project/history/1' });
    expect(entry.statusCode).toBe(404);
    expect(entry.json()).toEqual({ error: 'Card history entry not found', cardId: 'project', version_seq: 1 });
    const diff = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project/diff?from=1&to=2' });
    expect(diff.statusCode).toBe(404);
    expect(diff.json()).toEqual({ error: 'Card diff source not found', cardId: 'project', from: 1, to: 2, missing_version_seq: 2 });
    const bothMissing = await app.server.fastify.inject({ method: 'GET', url: '/api/cards/project/diff?from=2&to=3' });
    expect(bothMissing.statusCode).toBe(404);
    expect(bothMissing.json()).toEqual({ error: 'Card diff source not found', cardId: 'project', from: 2, to: 3, missing_version_seq: 2 });
  });

  it('does not register the removed debug runtime start route', async () => {
    const response = await app.server.fastify.inject({ method: 'POST', url: '/api/debug/runtime/start' });
    expect(response.statusCode).toBe(404);
  });

  it('omits the removed debug state aggregate while preserving distinct diagnostics', async () => {
    const removed = await app.server.fastify.inject({ method: 'GET', url: '/api/debug/state' });
    expect(removed.statusCode).toBe(404);

    const errors = await app.server.fastify.inject({ method: 'GET', url: '/api/debug/errors' });
    expect(errors.statusCode).toBe(200);
    expect(errors.json()).toEqual({ errors: expect.any(Array), total: expect.any(Number) });

    const timeline = await app.server.fastify.inject({ method: 'GET', url: '/api/debug/timeline' });
    expect(timeline.statusCode).toBe(200);
    expect(timeline.json()).toEqual({ events: expect.any(Array), total: expect.any(Number) });

    const doctor = await app.server.fastify.inject({ method: 'GET', url: '/api/debug/doctor' });
    expect(doctor.statusCode).toBe(200);
    expect(doctor.json()).toEqual({ status: expect.any(String), checks: expect.any(Array), issues: expect.any(Array) });

    const supervision = await app.server.fastify.inject({ method: 'GET', url: '/api/debug/supervision' });
    expect(supervision.statusCode).toBe(200);
    expect(supervision.json()).toEqual({ reviews: expect.any(Array), stats: expect.any(Object) });
  });

  it('returns a failed tool result unchanged from the agent conversation route', async () => {
    const sessionId = 'planner:project';
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    const failedContent = '{"success":false,"error":"tool execution failed","data":{"exit_code":2}}';
    const result: AgentMessage = {
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: sessionId,
      role: 'tool',
      kind: 'tool_result',
      content: failedContent,
      round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message_index: 2,
      block_index: 0,
      tool: 'run_command',
      tool_call_id: 'call-1',
      timestamp: '2026-07-16T00:00:00.000Z',
    };
    appendConversationBatch(projectRoot, [result]);

    const response = await app.server.fastify.inject({ method: 'GET', url: `/api/agents/${encodeURIComponent(sessionId)}/conversation` });

    expect(response.statusCode).toBe(200);
    expect(response.json().entries).toEqual([result]);
  });
});

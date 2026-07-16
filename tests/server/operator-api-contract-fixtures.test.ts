import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createNetServer } from 'node:net';
import { startApp, type App } from '../../src/boot/app.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

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
  writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), `models:\n  default: [test-model]\nproviders: {}\nruntime:\n  continuous_improvement: false\nserver:\n  host: 127.0.0.1\n  port: ${port}\n`);
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

  it('projects the canonical root card and process-local runtime', async () => {
    const response = await app.server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      projectRoot,
      projectId: expect.any(String),
      cardIndex: { total: 1 },
      runtime: expect.any(Object),
    });
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

import { initProjectTree, testProjectAuthority } from '../helpers/canonical-project.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initRuntimeState, readRuntimeState } from '../../src/runtime/state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { runtimeStateSchema } from '../../src/schemas/validators.js';
import { ensureTestSaivageConfig } from '../helpers/test-runtime-application.js';

const CORE_RUNTIME_STATE_KEYS = [
  'status',
  'project_id',
  'started_at',
  'updated_at',
] as const;

let root: string;
let server: ServerInstance;

function expectTopLevelKeys(body: Record<string, unknown>, keys: readonly string[]): void {
  for (const key of keys) expect(body).toHaveProperty(key);
}

function expectRuntimeStateContract(body: unknown): void {
  const parsed = runtimeStateSchema.safeParse(body);
  expect(parsed.success).toBe(true);
  if (!parsed.success) return;
  expectTopLevelKeys(parsed.data as unknown as Record<string, unknown>, CORE_RUNTIME_STATE_KEYS);
  expect(parsed.data.project_id).toBe('project');
  expect(parsed.data).not.toHaveProperty('queue');
  expect(parsed.data).not.toHaveProperty('running_processes');
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'saivage-operator-api-contract-'));
  initProjectTree(root);
  ensureTestSaivageConfig(root);
  initRuntimeState(root);
  server = await createServer({ environment: loadEnvironment(['node', 'test', '--project-root', root], process.env), authority: testProjectAuthority(root) });
});

afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('operator API response contracts', () => {
  it('GET /health exposes the liveness response keys', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, ['status', 'version', 'project']);
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.project).toBe('string');
    expect(body).not.toHaveProperty('runtime');
    expect(body).not.toHaveProperty('serverAvailability');
  });

  it('GET /health/ready exposes readiness response keys', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, ['status']);
    expect(['ready', 'not_ready']).toContain(body.status);
  });

  it('GET /api/state exposes runtime state keys and validates RuntimeState when present', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, ['projectRoot', 'projectId', 'runtime', 'cardIndex']);
    expect(body.cardIndex).toMatchObject({ total: expect.any(Number), byStatus: expect.any(Object), byType: expect.any(Object) });
    expectRuntimeStateContract(body.runtime);
  });

});

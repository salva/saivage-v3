import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { initRuntimeState, readRuntimeState } from '../../src/runtime/state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { runtimeStateSchema } from '../../src/schemas/validators.js';

const OPERATIONS_DOC = join(process.cwd(), 'docs/runbook/operations.md');
const CORE_RUNTIME_STATE_KEYS = [
  'status',
  'project_id',
  'started_at',
  'paused',
  'updated_at',
] as const;

let root: string;
let server: ServerInstance;

function documentedTopLevelKeys(sectionTitle: string): string[] {
  const doc = readFileSync(OPERATIONS_DOC, 'utf8');
  const section = doc.match(new RegExp(`### ${sectionTitle}\\n([\\s\\S]*?)(?:\\n### |\\n## |$)`));
  if (!section) throw new Error(`Missing ${sectionTitle} section in docs/runbook/operations.md`);
  const keysLine = section[1].match(/Expected top-level JSON keys: ([^.]+)\./);
  if (!keysLine) throw new Error(`Missing documented top-level JSON keys for ${sectionTitle}`);
  return keysLine[1].split(',').map((key) => key.trim().replace(/^`|`$/g, ''));
}

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
  initRuntimeState(root);
  server = await createServer(root);
});

afterEach(async () => {
  await server.stop();
  rmSync(root, { recursive: true, force: true });
});

describe('operator API documented response contracts', () => {
  it('GET /health matches the documented top-level response keys', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, documentedTopLevelKeys('Health'));
    expect(body.status).toBe('ok');
    expect(typeof body.version).toBe('string');
    expect(typeof body.project).toBe('string');
    expect(body).not.toHaveProperty('runtime');
    expect(body).not.toHaveProperty('serverAvailability');
  });

  it('GET /health/ready matches the documented readiness response keys', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/health/ready' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, documentedTopLevelKeys('Readiness'));
    expect(['ready', 'not_ready']).toContain(body.status);
  });

  it('GET /api/state matches documented keys and validates RuntimeState when present', async () => {
    const response = await server.fastify.inject({ method: 'GET', url: '/api/state' });
    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expectTopLevelKeys(body, documentedTopLevelKeys('Runtime state'));
    expect(body.cardIndex).toMatchObject({ total: expect.any(Number), byStatus: expect.any(Object), byType: expect.any(Object) });
    expectRuntimeStateContract(body.runtime);
  });

});

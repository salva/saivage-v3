import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerInstance } from '../../src/server/server.js';
import { resetAuthPolicyForTests } from '../../src/server/auth-policy.js';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { initRuntimeState } from '../../src/runtime/state.js';

const AUTH_TOKEN = 'identity-test-token';

function setupProject(root: string): void {
  const sd = join(root, '.saivage');
  for (const d of ['tmp/state', 'cards/by-id', 'cards/tree', 'cards/dependencies', 'notes/by-card', 'agents/sessions', 'agents/messages', 'diaries']) {
    mkdirSync(join(sd, d), { recursive: true });
  }
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ server: { host: '127.0.0.1', port: 8080 }, models: { default: ['test-model'] }, providers: {} }, null, 2));
  initRuntimeState(root);
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: {} }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
}

describe('operator runtime.getState identity', () => {
  let tmpDir: string;
  let server: ServerInstance | undefined;
  let originalToken: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-identity-'));
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
    resetAuthPolicyForTests();
    setupProject(tmpDir);
  });

  afterEach(async () => {
    if (server) {
      await server.stop();
      server = undefined;
    }
    if (originalToken === undefined) delete process.env['SAIVAGE_API_TOKEN'];
    else process.env['SAIVAGE_API_TOKEN'] = originalToken;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('GET /api/state includes projectRoot and projectId derived from the project directory', async () => {
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);

    const response = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.projectRoot).toBe(tmpDir);
    expect(body.projectId).toBe(basename(tmpDir));

    const parsed = parseOperatorResponse('runtime.getState', body);
    expect(parsed.projectRoot).toBe(tmpDir);
    expect(parsed.projectId).toBe(basename(tmpDir));
  });

  it('still emits projectRoot and projectId when runtime state file is absent', async () => {
    rmSync(join(tmpDir, '.saivage', 'tmp', 'state', 'runtime.json'), { force: true });
    const { createServer } = await import('../../src/server/server.js');
    server = await createServer(tmpDir);

    const response = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runtime).not.toBeNull();
    expect(body.runtime.status).toBe('idle');
    expect(body.projectRoot).toBe(tmpDir);
    expect(body.projectId).toBe(basename(tmpDir));
  });
});

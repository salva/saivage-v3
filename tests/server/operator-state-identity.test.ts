import { initProjectTree, testCompositionAuthority, testMutationComposition, testProjectAuthority } from '../helpers/canonical-project.js';
import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServerInstance } from '../../src/server/server.js';
import { createServer } from '../../src/server/server.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { parseOperatorResponse } from '../../src/contracts/operator-api.js';
import { initRuntimeState } from '../../src/runtime/state.js';

import { createTestRestartPort } from '../helpers/restart-port.js';

const AUTH_TOKEN = 'identity-test-token';

function setupProject(root: string): void {
  const sd = join(root, '.saivage');
  initProjectTree(root);
  writeFileSync(join(sd, 'saivage.yaml'), JSON.stringify({ server: { host: '127.0.0.1', port: 8080 }, models: { default: ['test-model'] }, providers: {} }, null, 2));
  initRuntimeState(root);
}

describe('operator runtime.getState identity', () => {
  let tmpDir: string;
  let server: ServerInstance | undefined;
  let originalToken: string | undefined;

  async function createTestServer(root: string) {
    return createServer({ environment: await loadEnvironment(['node', 'test', '--project-root', root], process.env, testMutationComposition(root)), authority: testProjectAuthority(root), mutationLane: testMutationComposition(root).lane, compositionAuthority: testCompositionAuthority(root), restartPort: createTestRestartPort() });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-identity-'));
    originalToken = process.env['SAIVAGE_API_TOKEN'];
    process.env['SAIVAGE_API_TOKEN'] = AUTH_TOKEN;
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
    server = await createTestServer(tmpDir);

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
    server = await createTestServer(tmpDir);

    const response = await server.fastify.inject({ method: 'GET', url: '/api/state', headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.runtime).not.toBeNull();
    expect(body.runtime.status).toBe('stopped');
    expect(body.projectRoot).toBe(tmpDir);
    expect(body.projectId).toBe(basename(tmpDir));
  });
});

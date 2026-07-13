import { initProjectTree, testCompositionAuthority, testMutationComposition, testProjectAuthority } from '../helpers/canonical-project.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { loadEnvironment } from '../../src/config/environment.js';

import { initRuntimeState, updateRuntimeState } from '../helpers/runtime-state.js';
import { ensureTestSaivageConfig } from '../helpers/test-runtime-application.js';

let root: string;
let server: ServerInstance | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-debug-state-pid-'));
  initProjectTree(root);
  ensureTestSaivageConfig(root);
  initRuntimeState(root);
});

afterEach(async () => {
  if (server) {
    await server.stop();
    server = undefined;
  }
  rmSync(root, { recursive: true, force: true });
});

describe('GET /api/debug/state pid overlay', () => {
  it('surfaces process.pid on body.runtime.pid', async () => {
    updateRuntimeState(root, { status: 'running' });
    server = await createServer({ environment: await loadEnvironment(['node', 'test', '--project-root', root], process.env, testMutationComposition(root)), authority: testProjectAuthority(root), mutationLane: testMutationComposition(root).lane, compositionAuthority: testCompositionAuthority(root) });
    const res = await server.fastify.inject({ method: 'GET', url: '/api/debug/state' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ runtime: { pid: number; status: string } | null }>();
    expect(body.runtime).not.toBeNull();
    expect(body.runtime!.pid).toBe(process.pid);
    expect(body.runtime!.pid).toBeGreaterThan(0);
  });
});

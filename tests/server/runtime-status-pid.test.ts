import { initProjectTree, testCompositionAuthority, testMutationComposition, testProjectAuthority } from '../helpers/canonical-project.js';
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { loadEnvironment } from '../../src/config/environment.js';

import { runtimeStatePath } from '../../src/runtime/state.js';
import { initRuntimeState } from '../helpers/runtime-state.js';
import { ensureTestSaivageConfig } from '../helpers/test-runtime-application.js';

let root: string;
let server: ServerInstance | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-runtime-status-pid-'));
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

describe('GET /api/runtime/status pid overlay', () => {
  it('returns process.pid in the live runtime branch', async () => {
    server = await createServer({ environment: await loadEnvironment(['node', 'test', '--project-root', root], process.env, testMutationComposition(root)), authority: testProjectAuthority(root), mutationLane: testMutationComposition(root).lane, compositionAuthority: testCompositionAuthority(root) });
    const res = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pid: number }>();
    expect(typeof body.pid).toBe('number');
    expect(body.pid).toBe(process.pid);
    expect(body.pid).toBeGreaterThan(0);
  });

  it('ignores stale pid persisted on disk and reports the live process.pid', async () => {
    // Write a runtime.json containing an extra pid key — the schema must
    // strip it on read, so /api/runtime/status must surface process.pid
    // and never the stale on-disk value.
    const stalePid = 99999;
    const now = new Date().toISOString();
    const payload = {
      version: 1,
      data: {
        status: 'stopped',
        project_id: 'project',
        pid: stalePid,
        started_at: now,
        active_card_run: null,
        updated_at: now,
      },
    };
    writeFileSync(runtimeStatePath(root), JSON.stringify(payload));

    server = await createServer({ environment: await loadEnvironment(['node', 'test', '--project-root', root], process.env, testMutationComposition(root)), authority: testProjectAuthority(root), mutationLane: testMutationComposition(root).lane, compositionAuthority: testCompositionAuthority(root) });
    const res = await server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ pid: number }>();
    expect(body.pid).toBe(process.pid);
    expect(body.pid).not.toBe(stalePid);
  });
});

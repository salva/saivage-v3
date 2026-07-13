import { initProjectTree, testProjectAuthority } from '../helpers/canonical-project.js';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { initRuntimeState } from '../../src/runtime/state.js';
import { createServer, type ServerInstance } from '../../src/server/server.js';
import { loadEnvironment } from '../../src/config/environment.js';
import { ensureTestSaivageConfig } from '../helpers/test-runtime-application.js';

let root: string;
let server: ServerInstance | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-notifications-endpoint-removed-'));
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

describe('removed notification and note list endpoints', () => {
  it('does not register notification or note list routes', async () => {
    server = await createServer({ environment: await loadEnvironment(['node', 'test', '--project-root', root], process.env), authority: testProjectAuthority(root) });

    const notificationResponse = await server.fastify.inject({ method: 'GET', url: '/api/notifications' });
    const notesResponse = await server.fastify.inject({ method: 'GET', url: '/api/notes' });

    expect(notificationResponse.statusCode).toBe(404);
    expect(notesResponse.statusCode).toBe(404);

    const routes = server.fastify.printRoutes();
    expect(routes).not.toMatch(/^.*\/api\/notifications(?:\b|\/).*$/m);
    expect(routes).not.toMatch(/^.*\/api\/notes(?:\b|\/).*$/m);
  });
});

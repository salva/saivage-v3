import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createNetServer } from 'node:net';
import { startApp, type App } from '../../src/boot/app.js';
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
});

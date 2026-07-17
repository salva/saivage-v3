import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer as createNetServer } from 'node:net';
import { startApp, type App } from '../../src/boot/app.js';
import { initProjectTree } from '../helpers/canonical-project.js';

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const address = probe.address();
  if (address === null || typeof address === 'string') throw new Error('Failed to reserve an ephemeral test port.');
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe('reset-current project runtime controls', () => {
  let projectRoot: string;
  let app: App;

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-control-e2e-'));
    initProjectTree(projectRoot);
    const port = await availablePort();
    writeFileSync(join(projectRoot, '.saivage', 'saivage.yaml'), `models:\n  default: [test-model]\nproviders:\n  test:\n    models: [test-model]\ncompaction:\n  enabled: true\n  input_budget_tokens: 1000\n  summarizer_candidate:\n    provider: test\n    account: null\n    model: test-model\nruntime:\n  continuous_improvement: false\nserver:\n  host: 127.0.0.1\n  port: ${port}\n`);
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

  it('exposes stopped state and idempotent project containment without durable runtime state', async () => {
    const status = await app.server.fastify.inject({ method: 'GET', url: '/api/runtime/status' });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ runtime: 'stopped', restart_server_available: false });

    const stop = await app.server.fastify.inject({ method: 'POST', url: '/api/runtime/stop-project' });
    expect(stop.statusCode).toBe(200);
    expect(stop.json()).toEqual({ status: 'stopped', contained: false });
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { run } from '../../src/cli.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';

const originalCwd = process.cwd();
afterEach(() => { process.chdir(originalCwd); jest.restoreAllMocks(); });

function runtimeStatus(status: 'running' | 'paused') {
  return { runtime: status, currentCardId: null, goalCount: 0, lastTickAt: null, restart_server_available: true, pid: process.pid, actorRuntime: { pauseMode: status, activeWork: 'none', cards: [], agents: [], diagnostics: [] } };
}

describe('Stage-I verified-live CLI delegation E2E', () => {
  it('delegates status/Pause/Resume/Stop only to the lock-published bearer endpoint over real HTTP', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-delegation-e2e-'));
    createProjectIdentity(root, 'CLI E2E');
    writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: divergent.invalid\n  port: 1\n');
    process.chdir(root);
    const requests: Array<{ method: string; url: string; authorization: string | undefined; contentType: string | undefined; body: string }> = [];
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, contentType: request.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/runtime/stop-project') response.end(JSON.stringify({ status: 'stopped', contained: true }));
        else response.end(JSON.stringify(runtimeStatus(request.url === '/api/runtime/pause' ? 'paused' : 'running')));
      });
    });
    await new Promise<void>((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('HTTP server has no port.');
    const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
    publishRuntimeControlEndpoint(lock, { origin: `http://127.0.0.1:${address.port}`, auth: 'bearer' });
    const prior = process.env.SAIVAGE_API_TOKEN;
    process.env.SAIVAGE_API_TOKEN = 'e2e-bearer-token';
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      for (const command of ['status', 'pause', 'resume', 'stop'] as const) await run(['node', 'saivage', command]);
      expect(requests).toEqual([
        { method: 'GET', url: '/api/runtime/status', authorization: 'Bearer e2e-bearer-token', contentType: undefined, body: '' },
        { method: 'POST', url: '/api/runtime/pause', authorization: 'Bearer e2e-bearer-token', contentType: undefined, body: '' },
        { method: 'POST', url: '/api/runtime/resume', authorization: 'Bearer e2e-bearer-token', contentType: undefined, body: '' },
        { method: 'POST', url: '/api/runtime/stop-project', authorization: 'Bearer e2e-bearer-token', contentType: undefined, body: '' },
      ]);
    } finally {
      if (prior === undefined) delete process.env.SAIVAGE_API_TOKEN; else process.env.SAIVAGE_API_TOKEN = prior;
      releaseRuntimeLifecycleLock(lock);
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns exact no-live outcomes and fails a verified-live null endpoint without HTTP fallback', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-no-live-e2e-'));
    try {
      createProjectIdentity(root, 'CLI no-live E2E');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
      await run(['node', 'saivage', 'stop']);
      expect(log).toHaveBeenLastCalledWith('{"status":"stopped","contained":false}');
      await expect(run(['node', 'saivage', 'pause'])).rejects.toThrow('No live Saivage runtime owns this project; cannot pause.');
      const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
      try {
        for (const command of ['status', 'pause', 'resume', 'stop'] as const) await expect(run(['node', 'saivage', command])).rejects.toThrow('active lifecycle owner; runtime control unavailable');
      } finally { releaseRuntimeLifecycleLock(lock); }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

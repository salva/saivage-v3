import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { acquireRuntimeLifecycleLock, publishRuntimeControlEndpoint, releaseRuntimeLifecycleLock } from '../../src/runtime/lock.js';

describe('CLI no-live runtime controls', () => {
  const originalCwd = process.cwd();
  afterEach(() => { process.chdir(originalCwd); jest.restoreAllMocks(); });

  it('reports process-local stopped status and an idempotent stop without creating state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      createProjectIdentity(root, 'CLI test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      const log = jest.spyOn(console, 'log').mockImplementation(() => {});
      await run(['node', 'saivage', 'status']);
      expect(log.mock.calls.map(([line]) => line)).toEqual(['Service: stopped (no live owner)', 'Runtime status: stopped', 'Current card: (none)']);
      log.mockClear();
      await run(['node', 'saivage', 'stop']);
      expect(log).toHaveBeenCalledWith('{"status":"stopped","contained":false}');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects pause and resume with the exact no-live error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      createProjectIdentity(root, 'CLI test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      await expect(run(['node', 'saivage', 'pause'])).rejects.toThrow('No live Saivage runtime owns this project; cannot pause.');
      await expect(run(['node', 'saivage', 'resume'])).rejects.toThrow('No live Saivage runtime owns this project; cannot resume.');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('uses only the verified live record endpoint and treats null generically', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      createProjectIdentity(root, 'CLI test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: wrong.example\n  port: 9999\n');
      process.chdir(root);
      const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
      for (const command of ['status', 'pause', 'resume', 'stop', 'restart_server']) {
        await expect(run(['node', 'saivage', command])).rejects.toThrow('active lifecycle owner; runtime control unavailable');
      }
      publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45678', auth: 'disabled' });
      const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ status: 'stopped', contained: true }), { status: 200 }));
      jest.spyOn(console, 'log').mockImplementation(() => {});
      await run(['node', 'saivage', 'stop']);
      expect(request.mock.calls[0]![0]).toBe('http://127.0.0.1:45678/api/runtime/stop-project');
      releaseRuntimeLifecycleLock(lock);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it.each(['status', 'pause', 'resume', 'stop'] as const)('uses the published bearer mode for verified-live %s and never puts the token in the URL', async (command) => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-bearer-'));
    try {
      createProjectIdentity(root, 'CLI bearer test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), 'server:\n  host: wrong.example\n  port: 9999\n');
      process.chdir(root);
      const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
      publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45679', auth: 'bearer' });
      const prior = process.env.SAIVAGE_API_TOKEN;
      process.env.SAIVAGE_API_TOKEN = 'test-cli-bearer';
      const runtimeStatus = { runtime: command === 'pause' ? 'paused' : 'running', currentCardId: null, started_at: '2026-07-18T00:00:00.000Z', restart_server_available: true, pid: process.pid, actorRuntime: { pauseMode: command === 'pause' ? 'paused' : 'running', cards: [], agents: [] } };
      const request = jest.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(command === 'stop' ? { status: 'stopped', contained: true } : runtimeStatus), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      jest.spyOn(console, 'log').mockImplementation(() => {});
      try { await run(['node', 'saivage', command]); } finally { if (prior === undefined) delete process.env.SAIVAGE_API_TOKEN; else process.env.SAIVAGE_API_TOKEN = prior; releaseRuntimeLifecycleLock(lock); }
      const [url, init] = request.mock.calls[0]!;
      expect(String(url)).not.toContain('test-cli-bearer');
      expect(new Headers((init as RequestInit).headers).get('Authorization')).toBe('Bearer test-cli-bearer');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('fails bearer delegation before HTTP when the credential is absent and never falls back after 401', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-bearer-failure-'));
    try {
      createProjectIdentity(root, 'CLI bearer failure');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      const lock = acquireRuntimeLifecycleLock({ projectRoot: root, mode: 'bound' });
      publishRuntimeControlEndpoint(lock, { origin: 'http://127.0.0.1:45680', auth: 'bearer' });
      const prior = process.env.SAIVAGE_API_TOKEN;
      delete process.env.SAIVAGE_API_TOKEN;
      const request = jest.spyOn(globalThis, 'fetch');
      await expect(run(['node', 'saivage', 'status'])).rejects.toThrow(/SAIVAGE_API_TOKEN/);
      expect(request).not.toHaveBeenCalled();
      process.env.SAIVAGE_API_TOKEN = 'wrong';
      request.mockResolvedValue(new Response(JSON.stringify({ code: 'unauthorized', message: 'Unauthorized' }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
      await expect(run(['node', 'saivage', 'status'])).rejects.toThrow('Unauthorized');
      expect(request).toHaveBeenCalledTimes(1);
      if (prior === undefined) delete process.env.SAIVAGE_API_TOKEN; else process.env.SAIVAGE_API_TOKEN = prior;
      releaseRuntimeLifecycleLock(lock);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('rejects every endpoint/auth override rather than silently rediscovering control authority', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      createProjectIdentity(root, 'CLI test');
      writeFileSync(join(root, '.saivage', 'saivage.yaml'), '{}\n');
      process.chdir(root);
      for (const args of [['--host', 'elsewhere'], ['--port', '1'], ['--config', 'alternate.yaml']]) {
        await expect(run(['node', 'saivage', 'status', ...args])).rejects.toThrow('status accepts no options.');
      }
      await expect(run(['node', 'saivage', 'stop_project'])).rejects.toThrow('Unknown command: stop_project');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

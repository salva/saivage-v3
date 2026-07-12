import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from '../../src/cli.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { acquireLock, releaseLock } from '../../src/runtime/lock.js';
import { readRuntimeState } from '../../src/runtime/state-api.js';
import { updateRuntimeState } from '../../src/runtime/state.js';

const originalCwd = process.cwd();
const originalFetch = globalThis.fetch;

afterEach(() => {
  process.chdir(originalCwd);
  globalThis.fetch = originalFetch;
  delete process.env['SAIVAGE_API_TOKEN'];
  jest.restoreAllMocks();
});

describe('CLI runtime control routing', () => {
  it('POSTs lock-held control to canonical REST with auth and performs no direct persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      initProjectTree(root);
      updateRuntimeState(root, { status: 'running' });
      process.chdir(root);
      acquireLock(root);
      process.env['SAIVAGE_API_TOKEN'] = 'test-token';
      const fetchMock = jest.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
      globalThis.fetch = fetchMock;

      await run(['node', 'cli', 'pause']);

      expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:8080/api/runtime/pause', {
        method: 'POST', headers: { authorization: 'Bearer test-token' },
      });
      expect(readRuntimeState(root)?.status).toBe('running');
    } finally {
      releaseLock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists unlocked control directly and makes no REST request', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      initProjectTree(root);
      updateRuntimeState(root, { status: 'running' });
      process.chdir(root);
      const fetchMock = jest.fn<typeof fetch>();
      globalThis.fetch = fetchMock;

      await run(['node', 'cli', 'pause']);

      expect(fetchMock).not.toHaveBeenCalled();
      expect(readRuntimeState(root)?.status).toBe('paused');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails a lock-held REST error without falling back to persistence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-cli-control-'));
    try {
      initProjectTree(root);
      process.chdir(root);
      acquireLock(root);
      globalThis.fetch = jest.fn<typeof fetch>().mockResolvedValue(new Response('server rejected', { status: 409 }));

      await expect(run(['node', 'cli', 'resume'])).rejects.toThrow('server rejected');
      expect(readRuntimeState(root)?.status).toBe('stopped');
    } finally {
      releaseLock(root);
      rmSync(root, { recursive: true, force: true });
    }
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { readProjectIdentity } from '../../src/persistence/project-identity.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct mutation composition', () => {
  it('holds the lifecycle lock through init identity publication and releases it afterward', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-'));
    roots.push(root);
    const project = await withDirectMutationComposition(root, 'init', testApplicationFatalPort, async (composition) => {
      await Promise.resolve();
      expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
      return composition.createAndBindProjectIdentity();
    });
    expect(readProjectIdentity(root)).toEqual(project);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('releases the exact lock when the direct mutation fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-failure-'));
    roots.push(root);
    await expect(withDirectMutationComposition(root, 'init', testApplicationFatalPort, async () => { await Promise.resolve(); throw new Error('mutation failed'); })).rejects.toThrow('mutation failed');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
  it('retains exclusion after async publication uncertainty even when fatalPort throws', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-fatal-'));
    roots.push(root);
    const uncertainty = new PublicationOutcomeUnknownError();
    await expect(withDirectMutationComposition(root, 'init', testApplicationFatalPort, async () => {
      await Promise.resolve();
      throw uncertainty;
    })).rejects.toThrow();
    expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
  });
  it('retains the lock and cancellation listeners when final containment fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-containment-'));
    roots.push(root);
    const before = { SIGINT: process.listeners('SIGINT'), SIGTERM: process.listeners('SIGTERM') };
    try {
      await expect(withDirectMutationComposition(root, 'init', testApplicationFatalPort, async (composition) => {
        jest.spyOn(composition.runner, 'terminateScopeTree').mockResolvedValueOnce({
          selected: ['p'], stopped: [],
          failed: [{ groupId: 'p', state: 'unconfirmed', diagnostic: 'test containment failure' }],
        });
        throw new Error('operation failed first');
      })).rejects.toThrow('Initializer process containment failed; lifecycle lock retained.');
      expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
      expect(process.listeners('SIGINT')).toHaveLength(before.SIGINT.length + 1);
      expect(process.listeners('SIGTERM')).toHaveLength(before.SIGTERM.length + 1);
    } finally {
      jest.restoreAllMocks();
      for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        for (const listener of process.listeners(signal)) {
          if (!before[signal].includes(listener)) process.removeListener(signal, listener);
        }
      }
    }
  });
});

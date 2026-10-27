import { afterEach, describe, expect, it } from '@jest/globals';
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
});

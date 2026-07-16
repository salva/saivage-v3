import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { readProjectIdentity } from '../../src/persistence/project-identity.js';
import { runtimeProcessLockFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('direct mutation composition', () => {
  it('holds the lifecycle lock through init identity publication and releases it afterward', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-'));
    roots.push(root);
    const project = withDirectMutationComposition(root, 'init', (composition) => {
      expect(existsSync(runtimeProcessLockFile(root))).toBe(true);
      return composition.createAndBindProjectIdentity();
    });
    expect(readProjectIdentity(root)).toEqual(project);
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });

  it('releases the exact lock when the direct mutation fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-mutation-failure-'));
    roots.push(root);
    expect(() => withDirectMutationComposition(root, 'init', () => { throw new Error('mutation failed'); })).toThrow('mutation failed');
    expect(existsSync(runtimeProcessLockFile(root))).toBe(false);
  });
});

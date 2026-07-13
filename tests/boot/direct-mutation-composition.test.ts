import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withDirectMutationComposition } from '../../src/boot/direct-mutation-composition.js';
import { projectIdentityDigest } from '../../src/persistence/project-identity-store.js';
import { readRuntimeLockStatus, runtimeLifecycleLockRecord } from '../../src/runtime/lock.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('direct mutation composition', () => {
  function root(): string {
    const value = mkdtempSync(join(tmpdir(), 'saivage-direct-composition-'));
    roots.push(value);
    return value;
  }

  it('creates and binds project identity under one held bootstrap owner', () => {
    const projectRoot = root();
    withDirectMutationComposition(projectRoot, 'init', (composition) => {
      expect(runtimeLifecycleLockRecord(composition.lifecycleLock).lock_state).toBe('bootstrap_unbound');
      const project = composition.createAndBindProjectIdentity();
      expect(runtimeLifecycleLockRecord(composition.lifecycleLock)).toMatchObject({ lock_state: 'bound', project_identity: projectIdentityDigest(project) });
      expect(() => withDirectMutationComposition(projectRoot, 'bound', () => undefined)).toThrow(/held by live PID/);
    });
    expect(readRuntimeLockStatus(projectRoot)).toEqual({ kind: 'missing' });
    expect(existsSync(join(projectRoot, '.saivage', 'project.json'))).toBe(true);
  });

  it('releases only its matching lock when command work throws', () => {
    const projectRoot = root();
    expect(() => withDirectMutationComposition(projectRoot, 'init', (composition) => {
      composition.createAndBindProjectIdentity();
      throw new Error('command failed');
    })).toThrow('command failed');
    expect(readRuntimeLockStatus(projectRoot)).toEqual({ kind: 'missing' });
  });
});

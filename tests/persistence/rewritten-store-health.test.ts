import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { IndeterminatePublicationError } = await import('../../src/persistence/errors.js');

let replacementFailure: Error | undefined;
jest.unstable_mockModule('../../src/persistence/durable-file-replacement.js', () => ({
  cleanupDurableReplacementTemporaries: () => undefined,
  durableReplacementTemporaryTargetBasename: () => null,
  publishDirectory: () => undefined,
  durablyReplaceFile: (path: string) => {
    if (replacementFailure) throw replacementFailure instanceof IndeterminatePublicationError
      ? replacementFailure
      : new Error(replacementFailure.message);
    void path;
  },
}));

const { ApplicationPersistenceHealth, PersistenceMutationUnhealthyError } = await import('../../src/application/persistence-health.js');
const { RuntimeStateStore } = await import('../../src/runtime/state.js');
const { createDefaultRuntimeState } = await import('../../src/runtime/default-state.js');
const { ProjectIdentityStore } = await import('../../src/persistence/project-identity-store.js');
const { AuthProfileRepository } = await import('../../src/auth/auth-profile-store.js');

let projectRoot: string;
beforeEach(() => { projectRoot = mkdtempSync(join(tmpdir(), 'saivage-rewritten-health-')); replacementFailure = undefined; });
afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

describe('rewritten store persistence health boundary', () => {
  const stores = [
    {
      name: 'runtime state',
      mutate: (health: InstanceType<typeof ApplicationPersistenceHealth>) => new RuntimeStateStore(projectRoot, health).replace(createDefaultRuntimeState()),
    },
    {
      name: 'project identity',
      mutate: (health: InstanceType<typeof ApplicationPersistenceHealth>) => new ProjectIdentityStore(projectRoot, health).create('test'),
    },
    {
      name: 'auth profiles',
      mutate: (health: InstanceType<typeof ApplicationPersistenceHealth>) => new AuthProfileRepository(projectRoot, health).replace({ version: 1, profiles: {} }),
    },
  ];

  for (const store of stores) {
    it(`${store.name} leaves known pre-publication replacement failure nonterminal`, () => {
      const health = new ApplicationPersistenceHealth();
      replacementFailure = new Error('known temporary write failure');
      expect(() => store.mutate(health)).toThrow(/known temporary write failure/);
      expect(health.snapshot()).toEqual({ state: 'healthy' });
    });

    it(`${store.name} terminally reports indeterminate publication`, () => {
      const health = new ApplicationPersistenceHealth();
      replacementFailure = new IndeterminatePublicationError(join(projectRoot, 'target'));
      expect(() => store.mutate(health)).toThrow(PersistenceMutationUnhealthyError);
      expect(health.snapshot()).toMatchObject({ state: 'mutation_unhealthy' });
    });
  }
});

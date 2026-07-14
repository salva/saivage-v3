import { basename } from 'node:path';
import { realpathSync } from 'node:fs';

import { ApplicationPersistenceHealth } from '../application/persistence-health.js';
import { ProjectIdentityStore, projectIdentityDigest } from '../persistence/project-identity-store.js';
import {
  acquireRuntimeLifecycleLock,
  bindRuntimeLifecycleLock,
  releaseRuntimeLifecycleLock,
  type RuntimeLifecycleLockHandle,
} from '../runtime/lock.js';

export interface DirectMutationComposition {
  readonly projectRoot: string;
  readonly lifecycleLock: RuntimeLifecycleLockHandle;
  readonly persistenceHealth: ApplicationPersistenceHealth;
  readonly projectIdentity: ProjectIdentityStore;
  createAndBindProjectIdentity(): ReturnType<ProjectIdentityStore['create']>;
}

export function withDirectMutationComposition<T>(
  projectRoot: string,
  mode: 'init' | 'bound',
  operation: (composition: DirectMutationComposition) => T,
): T {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: canonicalProjectRoot, mode });
  const persistenceHealth = new ApplicationPersistenceHealth();
  const projectIdentity = new ProjectIdentityStore(canonicalProjectRoot, persistenceHealth);
  const composition: DirectMutationComposition = Object.freeze({
    projectRoot: canonicalProjectRoot,
    lifecycleLock,
    persistenceHealth,
    projectIdentity,
    createAndBindProjectIdentity: () => {
      const project = projectIdentity.create(basename(canonicalProjectRoot) || 'saivage-project');
      bindRuntimeLifecycleLock(lifecycleLock, projectIdentityDigest(project));
      return project;
    },
  });
  try {
    return operation(composition);
  } finally {
    releaseRuntimeLifecycleLock(lifecycleLock);
  }
}

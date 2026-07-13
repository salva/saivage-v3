import { basename } from 'node:path';
import { realpathSync } from 'node:fs';

import { createMutationLane, type MutationLane } from '../application/mutation-lane.js';
import type { CompositionMutationAuthority } from '../application/mutation-authority.js';
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
  readonly lane: MutationLane;
  readonly authority: CompositionMutationAuthority;
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
  const { lane, authority } = createMutationLane();
  const projectIdentity = new ProjectIdentityStore(canonicalProjectRoot, lane, authority);
  const composition: DirectMutationComposition = Object.freeze({
    projectRoot: canonicalProjectRoot,
    lifecycleLock,
    lane,
    authority,
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

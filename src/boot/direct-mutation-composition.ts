import { basename } from 'node:path';
import { realpathSync } from 'node:fs';

import { createProjectIdentity, projectIdentityDigest } from '../persistence/project-identity.js';
import {
  acquireRuntimeLifecycleLock,
  bindRuntimeLifecycleLock,
  releaseRuntimeLifecycleLock,
  type RuntimeLifecycleLockHandle,
} from '../runtime/lock.js';

export interface DirectMutationComposition {
  readonly projectRoot: string;
  readonly lifecycleLock: RuntimeLifecycleLockHandle;
  createAndBindProjectIdentity(): ReturnType<typeof createProjectIdentity>;
}

export function withDirectMutationComposition<T>(
  projectRoot: string,
  mode: 'init' | 'bound',
  operation: (composition: DirectMutationComposition) => T,
): T {
  const canonicalProjectRoot = realpathSync(projectRoot);
  const lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: canonicalProjectRoot, mode });
  const composition: DirectMutationComposition = Object.freeze({
    projectRoot: canonicalProjectRoot,
    lifecycleLock,
    createAndBindProjectIdentity: () => {
      const project = createProjectIdentity(canonicalProjectRoot, basename(canonicalProjectRoot) || 'saivage-project');
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

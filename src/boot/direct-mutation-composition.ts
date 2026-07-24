import { basename } from 'node:path';
import { realpathSync } from 'node:fs';

import { createProjectIdentity, projectIdentityDigest } from '../persistence/project-identity.js';
import {
  acquireRuntimeLifecycleLock,
  bindRuntimeLifecycleLock,
  releaseRuntimeLifecycleLock,
  type RuntimeLifecycleLockHandle,
} from '../runtime/lock.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';

export interface DirectMutationComposition {
  readonly projectRoot: string;
  readonly lifecycleLock: RuntimeLifecycleLockHandle;
  createAndBindProjectIdentity(): ReturnType<typeof createProjectIdentity>;
}

export function withDirectMutationComposition<T>(
  projectRoot: string,
  mode: 'init' | 'bound',
  fatalPort: ApplicationFatalPort,
  operation: (composition: DirectMutationComposition) => T,
): T {
  const canonicalProjectRoot = realpathSync(projectRoot);
  let lifecycleLock: RuntimeLifecycleLockHandle;
  try { lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: canonicalProjectRoot, mode }); }
  catch (error) { if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error); throw error; }
  const composition: DirectMutationComposition = Object.freeze({
    projectRoot: canonicalProjectRoot,
    lifecycleLock,
    createAndBindProjectIdentity: () => {
      const project = createProjectIdentity(canonicalProjectRoot, basename(canonicalProjectRoot) || 'saivage-project');
      bindRuntimeLifecycleLock(lifecycleLock, projectIdentityDigest(project));
      return project;
    },
  });
  try { return operation(composition); }
  catch (error) { if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error); throw error; }
  finally { releaseRuntimeLifecycleLock(lifecycleLock); }
}

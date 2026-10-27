import { basename } from 'node:path';
import { realpathSync } from 'node:fs';

import { createProjectIdentity, projectIdentityDigest } from '../persistence/index.js';
import {
  acquireRuntimeLifecycleLock,
  bindRuntimeLifecycleLock,
  releaseRuntimeLifecycleLock,
  runtimeProcessIdentity,
  ManagedProcessGroupRegistry,
  ProcessRunner,
  type ManagedProcessScope,
  type RuntimeLifecycleLockHandle,
} from '../runtime/runtime-api.js';
import { PublicationOutcomeUnknownError, type ApplicationFatalPort } from '../contracts/index.js';

interface DirectMutationComposition {
  readonly projectRoot: string;
  readonly lifecycleLock: RuntimeLifecycleLockHandle;
  readonly runner: ProcessRunner;
  readonly parentScope: ManagedProcessScope;
  readonly signal: AbortSignal;
  readonly fatalPort: ApplicationFatalPort;
  assertCurrent(): void;
  createAndBindProjectIdentity(): ReturnType<typeof createProjectIdentity>;
}

export async function withDirectMutationComposition<T>(
  projectRoot: string,
  mode: 'init' | 'bound',
  fatalPort: ApplicationFatalPort,
  operation: (composition: DirectMutationComposition) => T | Promise<T>,
): Promise<T> {
  const canonicalProjectRoot = realpathSync(projectRoot);
  let lifecycleLock: RuntimeLifecycleLockHandle;
  try {
    lifecycleLock = acquireRuntimeLifecycleLock({ projectRoot: canonicalProjectRoot, mode });
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) fatalPort.publicationOutcomeUnknown(error);
    throw error;
  }
  let fatal = false;
  let active = true;
  const ownedFatalPort: ApplicationFatalPort = {
    publicationOutcomeUnknown(error) {
      fatal = true;
      return fatalPort.publicationOutcomeUnknown(error);
    },
  };
  const registry = new ManagedProcessGroupRegistry();
  const runner = new ProcessRunner(canonicalProjectRoot, registry, ownedFatalPort);
  const parentScope = registry.createContainerScope(registry.rootScope, 'initial-project');
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Project initialization interrupted.'));
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const composition: DirectMutationComposition = Object.freeze({
    projectRoot: canonicalProjectRoot,
    lifecycleLock,
    runner,
    parentScope,
    signal: controller.signal,
    fatalPort: ownedFatalPort,
    assertCurrent() {
      controller.signal.throwIfAborted();
      if (!active || fatal) throw new Error('Initializer no longer owns publication.');
      runtimeProcessIdentity(lifecycleLock);
    },
    createAndBindProjectIdentity: () => {
      composition.assertCurrent();
      const project = createProjectIdentity(
        canonicalProjectRoot,
        basename(canonicalProjectRoot) || 'saivage-project',
      );
      bindRuntimeLifecycleLock(lifecycleLock, projectIdentityDigest(project));
      return project;
    },
  });
  try {
    const result = await operation(composition);
    composition.assertCurrent();
    return result;
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError) {
      ownedFatalPort.publicationOutcomeUnknown(error);
    }
    throw error;
  } finally {
    if (!fatal) {
      active = false;
      runner.closeLaunchAdmission();
      const report = await runner.terminateScopeTree({ rootScope: registry.rootScope,
        categories: ['runtime_card', 'operator_session', 'service_infrastructure'],
        reason: 'Initializer settled', graceMs: 1000 });
      if (report.failed.length > 0)
        throw new Error('Initializer process containment failed; lifecycle lock retained.');
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      releaseRuntimeLifecycleLock(lifecycleLock);
    }
  }
}

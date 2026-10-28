import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { createResolvedConfigAuthority } from './config/index.js';
import { findProjectRoot } from './persistence/index.js';
import {
  acquireRuntimeLifecycleLock,
  readRuntimeLockStatus,
  releaseRuntimeLifecycleLock,
} from './runtime/runtime-api.js';
import {
  PublicationOutcomeUnknownError,
  type ApplicationFatalPort,
  type WorkGcRequest,
  type WorkGcResponse,
} from './contracts/index.js';
import {
  OperatorRuntimeHttpClient,
  workGcCompletedResponse,
  workGcFailureResponse,
  workGcOperationalInputs,
} from './application/index.js';
import { collectWorkGarbage, inventoryWorkGarbage } from './workspace/index.js';

export async function handleGcWork(
  request: WorkGcRequest,
  fatalPort: ApplicationFatalPort,
): Promise<void> {
  const selected = findProjectRoot();
  if (selected === null) throw new Error('Not in a Saivage project');
  const projectRoot = realpathSync(selected);
  const status = readRuntimeLockStatus(projectRoot);
  if (status.kind === 'live') {
    if (status.record.control_endpoint === null)
      throw new Error('active lifecycle owner; runtime control unavailable');
    const response = await new OperatorRuntimeHttpClient().gcWork(
      status.record.control_endpoint,
      request,
    );
    console.log(JSON.stringify(response));
    if (response.disposition !== 'completed') process.exitCode = 1;
    return;
  }
  if (status.kind === 'dead')
    throw new Error(`Runtime lock owner is positively dead. ${status.repairInstruction}`);
  if (status.kind !== 'missing')
    throw new Error(`Lifecycle lock ${status.kind}: ${status.detail}. ${status.repairInstruction}`);
  if (!process.stdin.isTTY)
    throw new Error(
      'Offline GC requires interactive exact quiescence acknowledgement; no unattended mode.',
    );
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error('Offline GC interrupted.'));
  let fatal = false;
  const ownedFatalPort: ApplicationFatalPort = {
    publicationOutcomeUnknown(error) {
      fatal = true;
      return fatalPort.publicationOutcomeUnknown(error);
    },
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const promptClosed = () =>
    controller.abort(new Error('Offline GC acknowledgement input closed.'));
  prompt.once('close', promptClosed);
  try {
    console.log(
      'Offline GC requires the exact service stopped, restarts excluded, and no surviving managed or unrelated writers throughout this command. Unknown writer state must refuse. Delete is irreversible; mistaken exclusion can destroy needed data. Preview also publishes a lifecycle lock.',
    );
    const phrase = `GC OFFLINE QUIESCENT ${projectRoot}`;
    if (
      (await prompt.question(`Type ${phrase} to confirm: `, { signal: controller.signal })) !==
      phrase
    )
      throw new Error('Offline GC quiescence acknowledgement refused.');
    controller.signal.throwIfAborted();
    let lock: ReturnType<typeof acquireRuntimeLifecycleLock>;
    try {
      lock = acquireRuntimeLifecycleLock({ projectRoot, mode: 'bound' });
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        ownedFatalPort.publicationOutcomeUnknown(error);
      throw error;
    }
    let response: WorkGcResponse;
    let reason: WorkGcResponse['reason'] = 'operational_inputs_invalid';
    try {
      const effective = createResolvedConfigAuthority({
        path: join(projectRoot, '.saivage', 'saivage.yaml'),
        projectRoot,
        interpolationEnvironment: process.env,
      }).loadEffective();
      controller.signal.throwIfAborted();
      reason = 'inventory_failed';
      const inventory = await inventoryWorkGarbage(projectRoot, controller.signal);
      controller.signal.throwIfAborted();
      reason = 'collection_failed';
      const result = await collectWorkGarbage(
        inventory,
        {
          mode: request.mode,
          before: request.before === undefined ? undefined : Date.parse(request.before),
          targetBytes: request.target_bytes,
        },
        {
          workflows: effective.workflows,
          operationalInputs: workGcOperationalInputs(effective.config, effective.workflows),
          protection: { retainAll: false, capturePaths: [] },
          assertCollecting: () => controller.signal.throwIfAborted(),
          fatal: (error) => ownedFatalPort.publicationOutcomeUnknown(error),
        },
      );
      response = workGcCompletedResponse(request, result, false);
    } catch (error) {
      // A throwing injected fatal port must not re-enter ordinary release/output.
      if (fatal) throw error;
      if (error instanceof PublicationOutcomeUnknownError)
        ownedFatalPort.publicationOutcomeUnknown(error);
      response = workGcFailureResponse(
        request,
        error,
        reason,
        controller.signal.aborted,
        'not_resumed',
      );
    }
    try {
      releaseRuntimeLifecycleLock(lock);
    } catch (error) {
      if (error instanceof PublicationOutcomeUnknownError)
        ownedFatalPort.publicationOutcomeUnknown(error);
      throw error;
    }
    console.log(JSON.stringify(response));
    if (response.disposition !== 'completed') process.exitCode = 1;
  } finally {
    if (!fatal) {
      prompt.removeListener('close', promptClosed);
      prompt.close();
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
    }
  }
}

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
  createWorkGcProgress,
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
    const controller = new AbortController();
    const cancel = () =>
      controller.abort(new Error('Online GC interrupted; server settlement is not certified.'));
    const outputError = (error: Error) => controller.abort(error);
    process.once('SIGINT', cancel);
    process.once('SIGTERM', cancel);
    process.stderr.on('error', outputError);
    try {
      const response = await new OperatorRuntimeHttpClient().gcWork(
        status.record.control_endpoint,
        request,
        controller.signal,
        (progress) => {
          if (!process.stderr.writableNeedDrain)
            process.stderr.write(`${JSON.stringify(progress)}\n`);
        },
      );
      console.log(JSON.stringify(response));
      if (response.disposition !== 'completed') process.exitCode = 1;
    } finally {
      process.removeListener('SIGINT', cancel);
      process.removeListener('SIGTERM', cancel);
      process.stderr.removeListener('error', outputError);
    }
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
  const outputError = (error: Error) => controller.abort(error);
  process.stderr.on('error', outputError);
  const progress = createWorkGcProgress(
    (snapshot) => {
      if (!process.stderr.writableNeedDrain) process.stderr.write(`${JSON.stringify(snapshot)}\n`);
    },
    (error) => controller.abort(error),
  );
  let fatal = false;
  const ownedFatalPort: ApplicationFatalPort = {
    publicationOutcomeUnknown(error) {
      fatal = true;
      return fatalPort.publicationOutcomeUnknown(error);
    },
  };
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  const promptClosed = () =>
    controller.abort(new Error('Offline GC acknowledgement input closed.'));
  prompt.once('close', promptClosed);
  try {
    console.error(
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
      const inventory = await inventoryWorkGarbage(projectRoot, controller.signal, progress);
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
          progress,
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
    progress({ phase: 'releasing' });
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
      process.stderr.removeListener('error', outputError);
    }
  }
}

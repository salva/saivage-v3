import { isDeepStrictEqual } from 'node:util';
import {
  PublicationOutcomeUnknownError,
  WorkGcBusyError,
  WorkGcMaintenanceError,
  type WorkGcRequest,
  type WorkGcResponse,
  type WorkGcResult,
  type ApplicationFatalPort,
  type WorkGcProgressObserver,
} from '../contracts/index.js';
import {
  collectWorkGarbage,
  inventoryWorkGarbage,
  WorkGcInterruptedError,
} from '../workspace/index.js';
import type { ResolvedConfigAuthority } from '../config/index.js';
import type { SaivageConfig } from '../schemas/index.js';
import type { CompiledProjectWorkflows, ProcessRunner } from '../runtime/runtime-api.js';
import type { RuntimeApplication } from './runtime-composition.js';
import { createWorkGcProgress } from './work-gc-progress.js';

// Compiled contracts contain immutable iterable maps/sets with private storage.
// Project their entries, not Object.keys (which would silently omit selected inputs).
function operationalValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Symbol.iterator in value) return Array.from(value as Iterable<unknown>, operationalValue);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, operationalValue(entry)]),
  );
}
function workflowInputs(workflows: CompiledProjectWorkflows): unknown {
  const {
    operations,
    analyst,
    analystPrompt,
    oversight,
    oversightPrompt,
    selectedGlobalParticipants,
    agents,
    cardTypes,
    cardTypeVocabulary,
    gitPolicy,
  } = workflows;
  return operationalValue({
    operations,
    analyst,
    analystPrompt,
    oversight,
    oversightPrompt,
    selectedGlobalParticipants,
    agents,
    cardTypes,
    cardTypeVocabulary,
    gitPolicy,
  });
}

export function workGcOperationalInputs(
  config: SaivageConfig,
  workflows: CompiledProjectWorkflows,
) {
  return { config, operations: operationalValue(workflows.operations) };
}

export function workGcCompletedResponse(
  request: WorkGcRequest,
  result: WorkGcResult,
  restoredRunning: boolean,
): WorkGcResponse {
  return {
    mode: request.mode,
    disposition: 'completed',
    reason: 'completed',
    restoration: restoredRunning ? 'resumed' : 'not_resumed',
    failure: null,
    result,
  };
}

export function workGcFailureResponse(
  request: WorkGcRequest,
  error: unknown,
  reason: WorkGcResponse['reason'],
  cancelled: boolean,
  restoration: WorkGcResponse['restoration'],
  completedResult: WorkGcResult | null = null,
): WorkGcResponse {
  const cause = error instanceof WorkGcMaintenanceError ? error.cause : error;
  const result = cause instanceof WorkGcInterruptedError ? cause.result : completedResult;
  const original = cause instanceof WorkGcInterruptedError ? cause.cause : cause;
  const code =
    original !== null && typeof original === 'object' && 'code' in original
      ? original.code
      : undefined;
  const syscall =
    original !== null && typeof original === 'object' && 'syscall' in original
      ? original.syscall
      : undefined;
  return {
    mode: request.mode,
    disposition: result ? 'interrupted' : 'refused',
    reason: cancelled ? 'cancelled' : reason,
    restoration,
    failure: cancelled
      ? null
      : {
          code:
            (
              [
                'EACCES',
                'EPERM',
                'ENOENT',
                'ENOTDIR',
                'EISDIR',
                'ENAMETOOLONG',
                'ELOOP',
                'EMFILE',
                'ENFILE',
                'ENOSPC',
                'EROFS',
                'EIO',
              ] as const
            ).find((value) => value === code) ?? 'unknown',
          syscall:
            (
              ['scandir', 'readdir', 'lstat', 'stat', 'realpath', 'open', 'read', 'close'] as const
            ).find((value) => value === syscall) ?? null,
        },
    result,
  };
}

export function runWorkGcOperation(input: {
  request: WorkGcRequest;
  signal: AbortSignal;
  projectRoot: string;
  config: SaivageConfig;
  workflows: CompiledProjectWorkflows;
  configAuthority: ResolvedConfigAuthority;
  processRunner: ProcessRunner;
  fatalPort: ApplicationFatalPort;
  run: RuntimeApplication['runWorkGc'];
  progress?: WorkGcProgressObserver;
  /** Marks transport fatal bypass before entering the terminal port, including throwing ports. */
  onFatal?: () => void;
}): Promise<WorkGcResponse> {
  const progress = createWorkGcProgress(input.progress);
  let fatal = false;
  const markFatal = () => {
    fatal = true;
    input.onFatal?.();
  };
  const failFatally = (error: PublicationOutcomeUnknownError): never => {
    markFatal();
    return input.fatalPort.publicationOutcomeUnknown(error);
  };
  let result: WorkGcResult | null = null;
  let failureReason: WorkGcResponse['reason'] = 'inventory_failed';
  // Reserve synchronously. Only the accepted task is converted to a completion response.
  const task = input.run({
       isFatal: () => fatal,
       onFatal: markFatal,
      signal: input.signal,
      inventory: async (signal) => {
        const inventory = await inventoryWorkGarbage(input.projectRoot, signal, progress);
        failureReason = 'maintenance_refused';
        progress?.phase('settling');
        return inventory;
      },
      collect: async (inventory, signal) => {
        signal.throwIfAborted();
        failureReason = 'operational_inputs_invalid';
        progress?.phase('validation_marking');
        const fresh = input.configAuthority.loadEffective();
        const operationalWorkflows = workflowInputs(fresh.workflows);
        if (
          !isDeepStrictEqual(fresh.config, input.config) ||
          !isDeepStrictEqual(operationalWorkflows, workflowInputs(input.workflows))
        )
          throw new Error(
            'Selected operational configuration differs from the running composition.',
          );
        failureReason = 'collection_failed';
        result = await collectWorkGarbage(
          inventory,
          {
            mode: input.request.mode,
            before:
              input.request.before === undefined ? undefined : Date.parse(input.request.before),
            targetBytes: input.request.target_bytes,
          },
          {
            progress,
            workflows: input.workflows,
            // Executable dependencies live in the selected configuration/operation definitions.
            // Expanded role instructions are checked for composition consistency above; their
            // retained conversation selections are independently marked by the canonical owner.
            operationalInputs: workGcOperationalInputs(fresh.config, fresh.workflows),
            protection: input.processRunner.workGcProtection(),
            assertCollecting: () => signal.throwIfAborted(),
            fatal: failFatally,
          },
        );
        return result;
      },
    });
  return task.then(completed =>
    workGcCompletedResponse(input.request, completed.value, completed.restoredRunning),
  (error: unknown) => {
    if (fatal) throw error;
    if (error instanceof PublicationOutcomeUnknownError)
      failFatally(error);
    if (error instanceof WorkGcBusyError) throw error;
    return workGcFailureResponse(
      input.request,
      error,
      failureReason,
      input.signal.aborted || (error instanceof WorkGcMaintenanceError && error.cancelled),
      error instanceof WorkGcMaintenanceError
        ? error.restoredRunning
          ? 'resumed'
          : 'not_resumed'
        : 'not_acquired',
      result,
    );
  });
}

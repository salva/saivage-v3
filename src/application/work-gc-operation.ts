import { isDeepStrictEqual } from 'node:util';
import {
  PublicationOutcomeUnknownError,
  WorkGcBusyError,
  WorkGcMaintenanceError,
  type WorkGcRequest,
  type WorkGcResponse,
  type WorkGcResult,
  type ApplicationFatalPort,
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
  return {
    mode: request.mode,
    disposition: result ? 'interrupted' : 'refused',
    reason: cancelled ? 'cancelled' : reason,
    restoration,
    result,
  };
}

export async function runWorkGcOperation(input: {
  request: WorkGcRequest;
  signal: AbortSignal;
  projectRoot: string;
  config: SaivageConfig;
  workflows: CompiledProjectWorkflows;
  configAuthority: ResolvedConfigAuthority;
  processRunner: ProcessRunner;
  fatalPort: ApplicationFatalPort;
  run: RuntimeApplication['runWorkGc'];
}): Promise<WorkGcResponse> {
  let result: WorkGcResult | null = null;
  let failureReason: WorkGcResponse['reason'] = 'inventory_failed';
  try {
    const completed = await input.run({
      signal: input.signal,
      inventory: async (signal) => {
        const inventory = await inventoryWorkGarbage(input.projectRoot, signal);
        failureReason = 'maintenance_refused';
        return inventory;
      },
      collect: async (inventory, signal) => {
        signal.throwIfAborted();
        failureReason = 'operational_inputs_invalid';
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
            workflows: input.workflows,
            // Executable dependencies live in the selected configuration/operation definitions.
            // Expanded role instructions are checked for composition consistency above; their
            // retained conversation selections are independently marked by the canonical owner.
            operationalInputs: workGcOperationalInputs(fresh.config, fresh.workflows),
            protection: input.processRunner.workGcProtection(),
            assertCollecting: () => signal.throwIfAborted(),
            fatal: (error) => input.fatalPort.publicationOutcomeUnknown(error),
          },
        );
        return result;
      },
    });
    return workGcCompletedResponse(input.request, completed.value, completed.restoredRunning);
  } catch (error) {
    if (error instanceof PublicationOutcomeUnknownError)
      input.fatalPort.publicationOutcomeUnknown(error);
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
  }
}

import { randomUUID } from 'node:crypto';
import { appendCardExecutions, type CardExecutionBinding } from '../../persistence/index.js';
import type { OperationValues } from '../card-process/operation-contract.js';
import type { CompiledActionExecution } from '../card-process/operation-routing.js';
import type { ManagedProcessScope, ProcessRunner } from '../process-runner.js';
import {
  executeFiniteOperation,
  resolveOperationReadablePath,
  type OperationExecutionResult,
} from '../operation-execution.js';

export interface OperationInvocation {
  projectRoot: string;
  cardId: string;
  execution: CompiledActionExecution;
  inputs: OperationValues;
  binding: CardExecutionBinding;
  collectOutput: boolean;
  processRunner: ProcessRunner;
  runtimeProcessRootScope: ManagedProcessScope;
  signal: AbortSignal;
  retainSettlementFailure(error: unknown): void;
}

/** Card-only evidence wrapper; the finite body needs neither a card nor a workflow. */
export function invokeOperation(args: OperationInvocation): Promise<OperationExecutionResult> {
  const invocationId = randomUUID();
  return executeFiniteOperation({
    invocationId,
    projectRoot: args.projectRoot,
    operation: args.execution.operation,
    config: args.execution.config,
    inputs: args.inputs,
    collectOutput: args.collectOutput,
    processRunner: args.processRunner,
    parentScope: args.runtimeProcessRootScope,
    attribution: {
      category: 'runtime_card',
      cardId: args.cardId,
      ownerId: invocationId,
      ownerKind: 'runtime',
    },
    signal: args.signal,
    resolveReadablePath: (path) => resolveOperationReadablePath(args.projectRoot, path),
    retainSettlementFailure: args.retainSettlementFailure,
    observe: (row) =>
      appendCardExecutions(args.projectRoot, args.cardId, [
        row.kind === 'invocation_started'
          ? { ...row, card_id: args.cardId, binding: args.binding }
          : { ...row, card_id: args.cardId },
      ]),
  });
}

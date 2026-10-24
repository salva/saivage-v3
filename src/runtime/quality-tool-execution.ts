import { randomUUID } from 'node:crypto';
import type { QualityToolPort } from '../contracts/index.js';
import type { QualityToolBindings, QualityToolName } from '../schemas/index.js';
import { workUrlFromAbsolutePath } from '../workspace/index.js';
import { join } from 'node:path';
import { redactTextForOutbound } from '../redaction/index.js';
import { executeFiniteOperation } from './operation-execution.js';
import type { OperationDefinition } from './card-process/operation-contract.js';
import type { ManagedProcessScope, ProcessRunner } from './process-runner.js';

const operationIds: Record<QualityToolName, string> = {
  code_quality_javascript_eslint: 'code-quality.javascript.eslint',
  code_quality_typescript_eslint: 'code-quality.typescript.eslint',
  code_quality_python_ruff: 'code-quality.python.ruff',
};
export function bindQualityToolExecution(args: {
  projectRoot: string;
  bindings?: Readonly<QualityToolBindings>;
  operations: ReadonlyMap<string, OperationDefinition>;
  processRunner: ProcessRunner;
  parentScope: ManagedProcessScope;
  ownerId: string;
  cardId?: string;
  sessionId?: string;
}): QualityToolPort {
  return {
    async invoke(name, caller, signal) {
      const config = args.bindings?.[name];
      if (!config) throw new Error(`Quality tool '${name}' has no bound operator configuration.`);
      const operation = args.operations.get(operationIds[name]);
      if (!operation)
        throw new Error(`Missing compiled quality operation '${operationIds[name]}'.`);
      let settlementFailure: { error: unknown } | null = null;
      const completed = await executeFiniteOperation({
        invocationId: randomUUID(),
        projectRoot: args.projectRoot,
        operation,
        config,
        inputs: {},
        processRunner: args.processRunner,
        parentScope: args.parentScope,
        attribution: {
          category: args.cardId ? 'runtime_card' : 'operator_session',
          cardId: args.cardId ?? null,
          ownerId: args.ownerId,
          ownerKind: args.cardId ? 'agent' : 'operator',
          agentSessionId: args.sessionId,
        },
        collectOutput: true,
        resolveReadablePath: caller.resolveReadablePath,
        signal,
        retainSettlementFailure(error) {
          settlementFailure ??= { error };
        },
      });
      if (settlementFailure) throw (settlementFailure as { error: unknown }).error;
      signal.throwIfAborted();
      if (!completed.completedOutput)
        throw new Error('Quality tool did not produce a completed report.');
      return {
        operation: operation.id,
        contract_version: 1,
        invocation_id: completed.invocationId,
        outcome: completed.result.outcome,
        summary: redactTextForOutbound(completed.result.summary),
        values: completed.result.values,
        report: redactTextForOutbound(completed.completedOutput.content),
        artifacts: completed.evidence.files.flatMap((file) =>
          file.kind === 'artifact'
            ? [
                {
                  path: workUrlFromAbsolutePath(
                    args.projectRoot,
                    join(args.projectRoot, file.path),
                  ),
                  size_bytes: file.size,
                },
              ]
            : [],
        ),
      };
    },
  };
}

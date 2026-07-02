import type { ExecutorResult } from './agent-execution.js';
import type {
  Contract,
  ContractTerminalDescriptor,
} from './contract.js';
import {
  ExecutorResultEnvelopeSchema,
  type ExecutorResultEnvelope,
} from './executor-envelope.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { describeTerminals } from './describe-terminals.js';
import { verifyAgainstTerminals } from './verify-against-terminals.js';
import { TERMINAL_RESULT_TOOL_NAME } from './result-envelope.js';

const EXECUTOR_TERMINAL_DESC =
  'Emit the executor result envelope as the final action of this turn.';

export function createExecutorContract(): Contract<ExecutorResultEnvelope, ExecutorResult> {
  const terminal: ContractTerminalDescriptor = {
    name: TERMINAL_RESULT_TOOL_NAME,
    description: EXECUTOR_TERMINAL_DESC,
    schema: ExecutorResultEnvelopeSchema,
    toolDefinition: {
      type: 'function',
      function: {
        name: TERMINAL_RESULT_TOOL_NAME,
        description: EXECUTOR_TERMINAL_DESC,
        parameters: zodToJsonSchemaMini(ExecutorResultEnvelopeSchema) as unknown as Record<string, unknown>,
      },
    },
  };
  const terminals: readonly ContractTerminalDescriptor[] = [terminal];

  return {
    name: 'executor',
    terminals,
    describe() {
      return describeTerminals(terminals);
    },
    isTerminalToolName(name) {
      return name === terminal.name;
    },
    verify(call) {
      return verifyAgainstTerminals<ExecutorResultEnvelope>(call, terminals, 'executor');
    },
    project(envelope) {
      return {
        status: envelope.status,
        summary: envelope.summary,
      };
    },
  };
}

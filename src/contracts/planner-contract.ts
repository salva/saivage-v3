import type { PlannerResult } from './agent-execution.js';
import type {
  Contract,
  ContractTerminalDescriptor,
} from './contract.js';
import {
  PlannerResultEnvelopeSchema,
  type PlannerResultEnvelope,
} from './planner-envelope.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { describeTerminals } from './describe-terminals.js';
import { verifyAgainstTerminals } from './verify-against-terminals.js';

export type PlannerEnvelope =
  | { kind: 'result'; payload: PlannerResultEnvelope };

export type PlannerTypedResult =
  | { kind: 'result'; result: PlannerResult };

const PLANNER_RESULT_TERMINAL_DESC =
  'Emit the planner result envelope as the final action of this turn.';

export function createPlannerContract(): Contract<PlannerEnvelope, PlannerTypedResult> {
  const resultTerminal: ContractTerminalDescriptor = {
    name: 'emit_planner_result',
    description: PLANNER_RESULT_TERMINAL_DESC,
    schema: PlannerResultEnvelopeSchema,
    toolDefinition: {
      type: 'function',
      function: {
        name: 'emit_planner_result',
        description: PLANNER_RESULT_TERMINAL_DESC,
        parameters: zodToJsonSchemaMini(PlannerResultEnvelopeSchema) as unknown as Record<string, unknown>,
      },
    },
  };
  const terminals: readonly ContractTerminalDescriptor[] = [resultTerminal];

  return {
    name: 'planner',
    terminals,
    describe() {
      return describeTerminals(terminals);
    },
    isTerminalToolName(name) {
      return terminals.some((t) => t.name === name);
    },
    verify(call) {
      const inner = verifyAgainstTerminals<unknown>(call, terminals, 'planner');
      if (!inner.ok) return inner;
      return {
        ok: true,
        terminalName: inner.terminalName,
        envelope: { kind: 'result', payload: inner.envelope as PlannerResultEnvelope },
      };
    },
    project(envelope) {
      const parsed = envelope.payload;
      return {
        kind: 'result',
        result: {
          status: parsed.status,
          blocked_reason: parsed.blocked_reason ?? undefined,
          summary: parsed.summary,
        },
      };
    },
  };
}

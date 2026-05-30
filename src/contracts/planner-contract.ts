import type { PlannerResult } from './agent-execution.js';
import type {
  Contract,
  ContractTerminalDescriptor,
} from './contract.js';
import {
  PlannerResultEnvelopeSchema,
  type PlannerResultEnvelope,
} from './planner-envelope.js';
import {
  deferredActivationEnvelopeV1Schema,
  type DeferredActivationEnvelopeV1,
} from '../schemas/index.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { describeTerminals } from './describe-terminals.js';
import { verifyAgainstTerminals } from './verify-against-terminals.js';

export interface PlannerContractInput {
  goalId: string;
  parentSessionId: string;
}

export type PlannerEnvelope =
  | { kind: 'result'; payload: PlannerResultEnvelope }
  | { kind: 'deferred'; payload: DeferredActivationEnvelopeV1 };

export type PlannerTypedResult =
  | { kind: 'result'; result: PlannerResult }
  | { kind: 'deferred'; result: PlannerResult; activations: DeferredActivationEnvelopeV1[] };

const PLANNER_RESULT_TERMINAL_DESC =
  'Emit the planner result envelope as the final action of this turn.';
const PLANNER_DEFERRED_TERMINAL_DESC =
  'End this turn deferring on an in-flight child activation. Echo the deferred_activate_card envelope returned by activate_card.';

export function createPlannerContract(
  _input: PlannerContractInput,
): Contract<PlannerEnvelope, PlannerTypedResult> {
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
  const deferredTerminal: ContractTerminalDescriptor = {
    name: 'emit_planner_deferred',
    description: PLANNER_DEFERRED_TERMINAL_DESC,
    schema: deferredActivationEnvelopeV1Schema,
    toolDefinition: {
      type: 'function',
      function: {
        name: 'emit_planner_deferred',
        description: PLANNER_DEFERRED_TERMINAL_DESC,
        parameters: zodToJsonSchemaMini(deferredActivationEnvelopeV1Schema) as unknown as Record<string, unknown>,
      },
    },
  };
  const terminals: readonly ContractTerminalDescriptor[] = [resultTerminal, deferredTerminal];

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
      if (inner.terminalName === 'emit_planner_result') {
        return {
          ok: true,
          terminalName: inner.terminalName,
          envelope: { kind: 'result', payload: inner.envelope as PlannerResultEnvelope },
        };
      }
      return {
        ok: true,
        terminalName: inner.terminalName,
        envelope: { kind: 'deferred', payload: inner.envelope as DeferredActivationEnvelopeV1 },
      };
    },
    project(envelope) {
      if (envelope.kind === 'result') {
        const parsed = envelope.payload;
        return {
          kind: 'result',
          result: {
            status: parsed.status,
            blocked_reason: parsed.blocked_reason ?? undefined,
            created_cards: parsed.created_cards,
            updated_cards: parsed.updated_cards,
            summary: parsed.summary,
          },
        };
      }
      const d = envelope.payload;
      return {
        kind: 'deferred',
        result: {
          status: 'continue',
          created_cards: [],
          updated_cards: [],
          summary: `Activated child ${d.child_card_id}; awaiting completion.`,
        },
        activations: [d],
      };
    },
  };
}

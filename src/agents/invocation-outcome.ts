import type { LlmTransportFailure } from '../contracts/llm-failure.js';
import type { ObligationReport } from './contract-verifier.js';

export interface RepairBudget {
  readonly max: number;
  consumed: number;
}

export function createRepairBudget(max: number): RepairBudget {
  return { max: Math.max(0, max), consumed: 0 };
}

export type InvocationOutcomeOf<Envelope, TypedResult> =
  | {
      kind: 'succeeded';
      envelope: Envelope;
      result: TypedResult;
      terminalName: string;
      repairAttempts: number;
    }
  | { kind: 'repair_exhausted'; lastReport: ObligationReport; repairAttempts: number }
  | { kind: 'no_progress'; turnsConsumed: number; repairAttempts: number }
  | { kind: 'transport_failed'; failure: LlmTransportFailure }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };

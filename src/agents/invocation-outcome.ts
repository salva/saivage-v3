import type { LlmTransportFailure } from '../contracts/llm-failure.js';

export type InvocationOutcomeOf<Envelope, TypedResult> =
  | {
      kind: 'succeeded';
      envelope: Envelope;
      result: TypedResult;
      terminalName: string;
      repairAttempts: number;
    }
  | { kind: 'transport_failed'; failure: LlmTransportFailure }
  | { kind: 'cancelled'; reason: 'abort' | 'timeout' };

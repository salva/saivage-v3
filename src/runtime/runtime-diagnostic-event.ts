import type { RuntimeDiagnosticEvent } from '../schemas/index.js';

export interface RuntimeDiagnosticInput {
  goal_id?: string;
  card_id?: string;
  phase?: string;
  error: unknown;
}

export type RuntimeDiagnosticEventInput = Pick<RuntimeDiagnosticEvent, 'kind' | 'goal_id' | 'card_id' | 'phase' | 'error_message'>;

export function buildRuntimeDiagnosticEvent(input: RuntimeDiagnosticInput): RuntimeDiagnosticEventInput {
  const error = input.error instanceof Error ? input.error : new Error(String(input.error));
  return {
    kind: 'runtime_diagnostic',
    error_message: error.message,
    ...(input.goal_id !== undefined ? { goal_id: input.goal_id } : {}),
    ...(input.card_id !== undefined ? { card_id: input.card_id } : {}),
    ...(input.phase !== undefined ? { phase: input.phase } : {}),
  };
}

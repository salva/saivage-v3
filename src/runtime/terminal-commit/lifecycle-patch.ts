import type { CardLifecycleState, CardRecord } from '../../schemas/index.js';

export function lifecyclePatch(lifecycle: CardLifecycleState): Pick<CardRecord, 'status' | 'result' | 'error' | 'completed_at'> {
  return {
    status: lifecycle.status,
    result: lifecycle.result as CardRecord['result'],
    error: lifecycle.error,
    completed_at: lifecycle.completed_at,
  };
}

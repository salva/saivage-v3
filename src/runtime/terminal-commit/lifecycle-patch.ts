import type { CardLifecycleState, CardRecord } from '../../schemas/index.js';

export function lifecycleCardPatch(lifecycle: CardLifecycleState): Pick<CardRecord, 'status' | 'lifecycle'> {
  return {
    status: lifecycle.status,
    lifecycle,
  };
}

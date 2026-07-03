import type { RuntimeState } from '../schemas/index.js';

export function deriveCurrentCardId(state: Pick<RuntimeState, 'active_card_run'> | null | undefined): string | null {
  return state?.active_card_run?.card_id ?? null;
}

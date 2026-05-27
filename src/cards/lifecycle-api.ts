export {
  buildNewCard,
  buildUpdatedCard,
  canTransition,
  collectChangedFields,
  isTerminalState,
  isTerminalType,
  normalizeNewCardId,
  prunePartialPatch,
  summarizeChangedFields,
  validateMutablePatch,
  validateTransition,
} from './lifecycle.js';
export type { BuildNewCardParams, MutablePatchFacts, NewCardInput } from './lifecycle.js';

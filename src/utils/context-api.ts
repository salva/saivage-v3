/** Shared pure conversation semantics; persistence owns strict source consumption. */
export {
  composeConversationContext,
  conversationWorkProtection,
  currentCoveredRequiredFactRows,
  projectedCanonicalRowContent,
  composeContextProjection,
  providerConversationFromComposedContext,
  selectLatestContextBlocks,
} from './context/composition-projector.js';
export type { SummarizerContextItem } from './context/composition-projector.js';
export { classifyConversationRowPolicy } from './context/row-policy.js';

import type { LiveSyncCardInvalidateTarget } from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';

export interface FreshnessEffects {
  runtimeChanged(): void;
  cardProjectionChanged(target: LiveSyncCardInvalidateTarget): void;
  agentsChanged(): void;
  conversationChanged(id: ConversationSessionId): void;
  timelineChanged(): void;
}

export const NO_FRESHNESS_EFFECTS: FreshnessEffects = Object.freeze({
  runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged() {}, conversationChanged() {}, timelineChanged() {},
});

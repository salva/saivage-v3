import type { LiveSyncCardInvalidateTarget } from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';
import type { CardId } from '../schemas/card-id.js';

export type AgentMembershipFreshnessTarget =
  | { readonly scope: 'card'; readonly cardId: CardId }
  | { readonly scope: 'global-session'; readonly sessionId: ConversationSessionId };
export interface ConversationFreshnessTarget { readonly session_id: ConversationSessionId; readonly segment_version: number; readonly visible_message_id: string | null }

export interface FreshnessEffects {
  runtimeChanged(): void;
  cardProjectionChanged(target: LiveSyncCardInvalidateTarget): void;
  agentMembershipChanged(target: AgentMembershipFreshnessTarget): void;
  conversationChanged(target: ConversationFreshnessTarget): void;
  llmExchangeChanged(id: ConversationSessionId): void;
  timelineChanged(): void;
}

export const NO_FRESHNESS_EFFECTS: FreshnessEffects = Object.freeze({
  runtimeChanged() {},
  cardProjectionChanged() {},
  agentMembershipChanged() {},
  conversationChanged() {},
  llmExchangeChanged() {},
  timelineChanged() {},
});

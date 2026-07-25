import type { FreshnessEffects } from '../application/freshness-effects.js';
import type { LiveSyncCardInvalidateTarget, LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';
import type { AgentMembershipFreshnessTarget } from '../application/freshness-effects.js';
import type { LiveSyncSocket } from './live-sync-socket.js';

function targetKey(target: LiveSyncInvalidateTarget): string {
  if (target.resource === 'conversation' || target.resource === 'llm-exchange')
    return `${target.resource}\u0000${target.id}`;
  if (target.resource === 'agent-membership')
    return target.scope === 'card'
      ? `${target.resource}\u0000card\u0000${target.card_id}`
      : `${target.resource}\u0000global-session\u0000${target.session_id}`;
  if (target.resource === 'cards')
    return target.scope === 'record'
      ? `${target.resource}\u0000${target.scope}\u0000${target.card_id}\u0000${target.record_name}`
      : `${target.resource}\u0000${target.scope}\u0000${target.card_id}`;
  return target.resource;
}

export class SyncHub implements FreshnessEffects {
  readonly #pending = new Map<string, LiveSyncInvalidateTarget>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  constructor(
    private readonly liveSyncSocket: LiveSyncSocket,
    private readonly debounceMs = 75,
  ) {}
  dispose(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#pending.clear();
  }
  runtimeChanged(): void {
    this.markDirty({ resource: 'runtime' });
  }
  cardProjectionChanged(target: LiveSyncCardInvalidateTarget): void {
    this.markDirty(target);
  }
  agentMembershipChanged(target: AgentMembershipFreshnessTarget): void {
    this.markDirty(
      target.scope === 'card'
        ? { resource: 'agent-membership', scope: 'card', card_id: target.cardId }
        : { resource: 'agent-membership', scope: 'global-session', session_id: target.sessionId },
    );
  }
  conversationChanged(id: ConversationSessionId, throughMessageId: string): void {
    this.markDirty({ resource: 'conversation', id, through_message_id: throughMessageId });
  }
  llmExchangeChanged(id: ConversationSessionId): void {
    this.markDirty({ resource: 'llm-exchange', id });
  }
  timelineChanged(): void {
    this.markDirty({ resource: 'timeline' });
  }
  private markDirty(target: LiveSyncInvalidateTarget): void {
    try {
      this.#pending.set(targetKey(target), target);
      if (!this.#timer) this.#timer = setTimeout(() => this.flush(), this.debounceMs);
    } catch {
      /* Freshness is deliberately lossy and non-throwing. */
    }
  }
  private flush(): void {
    this.#timer = null;
    const targets = [...this.#pending.values()];
    this.#pending.clear();
    for (const target of targets) {
      try {
        this.liveSyncSocket.invalidate(target);
      } catch {
        /* lossy */
      }
    }
  }
}

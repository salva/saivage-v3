import type { FreshnessEffects } from '../application/freshness-effects.js';
import type { LiveSyncCardInvalidateTarget, LiveSyncInvalidateTarget } from '../contracts/index.js';
import type { ConversationSessionId } from '../schemas/index.js';
import type { LiveSyncSocket } from './live-sync-socket.js';

function targetKey(target: LiveSyncInvalidateTarget): string {
  if (target.resource === 'conversation') return `${target.resource}\u0000${target.id}`;
  if (target.resource === 'cards') return target.scope === 'record'
    ? `${target.resource}\u0000${target.scope}\u0000${target.card_id}\u0000${target.record_name}`
    : `${target.resource}\u0000${target.scope}\u0000${target.card_id}`;
  return target.resource;
}

export class SyncHub implements FreshnessEffects {
  readonly #pending = new Map<string, LiveSyncInvalidateTarget>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private readonly liveSyncSocket: LiveSyncSocket, private readonly debounceMs = 75) {}
  dispose(): void { if (this.#timer) clearTimeout(this.#timer); this.#timer = null; this.#pending.clear(); }
  runtimeChanged(): void { this.markDirty({ resource: 'runtime' }); }
  cardProjectionChanged(target: LiveSyncCardInvalidateTarget): void { this.markDirty(target); }
  agentsChanged(): void { this.markDirty({ resource: 'agents' }); }
  conversationChanged(id: ConversationSessionId): void { this.markDirty({ resource: 'conversation', id }); }
  timelineChanged(): void { this.markDirty({ resource: 'timeline' }); }
  private markDirty(target: LiveSyncInvalidateTarget): void {
    try {
      this.#pending.set(targetKey(target), target);
      if (!this.#timer) this.#timer = setTimeout(() => this.flush(), this.debounceMs);
    } catch { /* Freshness is deliberately lossy and non-throwing. */ }
  }
  private flush(): void {
    this.#timer = null;
    const targets = [...this.#pending.values()]; this.#pending.clear();
    for (const target of targets) { try { this.liveSyncSocket.invalidate(target); } catch { /* lossy */ } }
  }
}

import type { ConversationSessionId } from '../schemas/index.js';
import type { LiveSyncCardInvalidateTarget } from '../contracts/index.js';

export type CardProjectionChange = LiveSyncCardInvalidateTarget;

export interface ReadModelChangeListener {
  runtimeChanged(): void;
  cardProjectionChanged(target: CardProjectionChange): void;
  agentsChanged(): void;
  conversationChanged(sessionId: ConversationSessionId): void;
}

export interface ReadModelChangeSubscription {
  unsubscribe(): void;
}

export interface ReadModelChanges extends ReadModelChangeListener {
  subscribe(listener: ReadModelChangeListener): ReadModelChangeSubscription;
}

export class ReadModelChangeBroadcaster implements ReadModelChanges {
  private readonly listeners = new Set<ReadModelChangeListener>();

  subscribe(listener: ReadModelChangeListener): ReadModelChangeSubscription {
    this.listeners.add(listener);
    let subscribed = true;
    return {
      unsubscribe: () => {
        if (!subscribed) return;
        subscribed = false;
        this.listeners.delete(listener);
      },
    };
  }

  runtimeChanged(): void { this.publish((listener) => listener.runtimeChanged()); }
  cardProjectionChanged(target: CardProjectionChange): void { this.publish((listener) => listener.cardProjectionChanged(target)); }
  agentsChanged(): void { this.publish((listener) => listener.agentsChanged()); }
  conversationChanged(sessionId: ConversationSessionId): void { this.publish((listener) => listener.conversationChanged(sessionId)); }

  private publish(notify: (listener: ReadModelChangeListener) => void): void {
    for (const listener of [...this.listeners]) {
      try { notify(listener); } catch { /* Freshness is a lossy, non-throwing hint. */ }
    }
  }
}

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCardStore } from '../stores/cards';

const wsTypeHandlers = new Map<string, Set<(envelope: any) => void>>();

vi.mock('../api/client', () => ({
  listCards: vi.fn(), getCard: vi.fn(), createCard: vi.fn(), updateCard: vi.fn(), deleteCard: vi.fn(),
  listCardHistory: vi.fn(), getCardHistoryEntry: vi.fn(), getCardDiff: vi.fn(),
  ApiError: class extends Error { status: number; body: Record<string, unknown>; constructor(status: number, message: string, body: Record<string, unknown> = {}) { super(message); this.name='ApiError'; this.status=status; this.body=body; } get isUnauthorized() { return this.status === 401; } get isNotFound() { return this.status === 404; } },
}));
vi.mock('../stores/ws', () => ({
  useWsStore: vi.fn(() => ({
    onType: (type: string, handler: (envelope: any) => void) => {
      let set = wsTypeHandlers.get(type);
      if (!set) {
        set = new Set();
        wsTypeHandlers.set(type, set);
      }
      set.add(handler);
      return () => set?.delete(handler);
    },
  })),
}));

function emitActivity(content: Record<string, unknown>): void {
  for (const handler of Array.from(wsTypeHandlers.get('activity') ?? [])) {
    handler({ type: 'activity', content });
  }
}

describe('stale warning ribbon state', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    wsTypeHandlers.clear();
    vi.clearAllMocks();
  });

  it('appears for current card after websocket notification_added and clears on websocket acknowledgement', () => {
    const store = useCardStore();
    store.currentCard = { id: 'card-1' } as any;
    store.setupWsListener();

    emitActivity({ event: 'notification_added', related_card_id: 'card-1' });
    expect(store.currentCardHasStaleWarning).toBe(true);

    emitActivity({ event: 'notification_acknowledged', related_card_id: 'card-1' });
    expect(store.currentCardHasStaleWarning).toBe(false);
  });

  it('does not mark unrelated cards as stale for the current card view', () => {
    const store = useCardStore();
    store.currentCard = { id: 'card-1' } as any;
    store.setupWsListener();

    emitActivity({ event: 'notification_added', related_card_id: 'card-2' });
    expect(store.currentCardHasStaleWarning).toBe(false);
  });

  it('clears the active-card stale warning when a relevant card update arrives', () => {
    const store = useCardStore();
    store.currentCard = { id: 'card-1', title: 'Before' } as any;
    store.setupWsListener();

    emitActivity({ event: 'notification_added', related_card_id: 'card-1' });
    expect(store.currentCardHasStaleWarning).toBe(true);

    emitActivity({ event: 'card-updated', card: { id: 'card-1', title: 'After' } });
    expect(store.currentCardHasStaleWarning).toBe(false);
    expect(store.currentCard?.title).toBe('After');
  });
});
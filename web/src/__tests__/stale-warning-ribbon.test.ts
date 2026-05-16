import { describe, it, expect } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { useCardStore } from '../stores/cards';

describe('stale warning ribbon state', () => {
  it('appears for current card after notification_added and clears on acknowledgement', () => {
    setActivePinia(createPinia());
    const store = useCardStore();
    store.currentCard = { id: 'card-1' } as any;
    store.setCardStaleNotification('card-1', true);
    expect(store.currentCardHasStaleWarning).toBe(true);
    store.setCardStaleNotification('card-1', false);
    expect(store.currentCardHasStaleWarning).toBe(false);
  });

  it('does not mark unrelated cards as stale for the current card view', () => {
    setActivePinia(createPinia());
    const store = useCardStore();
    store.currentCard = { id: 'card-1' } as any;
    store.setCardStaleNotification('card-2', true);
    expect(store.currentCardHasStaleWarning).toBe(false);
  });
});
import { describe, expect, it } from 'vitest';
import ribbonSource from '../components/cards/StaleWarningRibbon.vue?raw';
import detailSource from '../components/cards/CardDetailView.vue?raw';
import storeSource from '../stores/cards.ts?raw';

describe('StaleWarningRibbon S06 store-driven warning', () => {
  it('is rendered from cardsStore.isStale and exposes no acknowledgement control', () => {
    expect(detailSource).toContain('StaleWarningRibbon :card-id="currentCard.id"');
    expect(ribbonSource).toContain('v-if="cardsStore.isStale(cardId)"');
    expect(ribbonSource).toContain("import { useCardStore } from '../../stores/cards';");
    expect(storeSource).toContain('function isStale(cardId: string): boolean');
    expect(storeSource).toContain('staleNotificationByCard.value[cardId] === true');

    expect(ribbonSource).toContain('Card update available.');
    const removedNotificationEvent = ['notification', 'acknowledged'].join('_');
    expect(ribbonSource).not.toMatch(/acknowledge|@click|button/i);
    expect(ribbonSource).not.toContain(removedNotificationEvent);
    expect(detailSource).not.toContain(removedNotificationEvent);
    expect(detailSource).not.toMatch(/acknowledgeNotification/);
  });
});

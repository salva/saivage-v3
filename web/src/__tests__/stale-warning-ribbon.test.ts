import { describe, expect, it } from 'vitest';
import ribbonSource from '../components/cards/StaleWarningRibbon.vue?raw';
import detailSource from '../components/cards/CardDetailView.vue?raw';
import storeSource from '../stores/cards.ts?raw';

describe('StaleWarningRibbon S06 store-driven warning', () => {
  it('is rendered from cardsStore.isStale and exposes no acknowledgement control', () => {
    expect(detailSource).toContain('StaleWarningRibbon v-if="cardStore.isStale(currentCard.id)"');
    expect(storeSource).toContain('function isStale(cardId: string): boolean');
    expect(storeSource).toContain('staleNotificationByCard.value[cardId] === true');

    expect(ribbonSource).toContain('Card update available.');
    expect(ribbonSource).not.toMatch(/acknowledge|notification_acknowledged|@click|button/i);
    expect(detailSource).not.toMatch(/notification_acknowledged|acknowledgeNotification/);
  });
});

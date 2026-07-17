import { describe, expect, it } from 'vitest';
import detailSource from '../components/cards/CardDetailView.vue?raw';
import recordsSource from '../components/cards/CardRecordsSection.vue?raw';

describe('CardDetailView S06 read-only detail contract', () => {
  it('retains refresh, dispatch navigation, and record-output affordances', () => {
    expect(detailSource).toContain('Refresh card');
    expect(detailSource).toContain('reloadDetail');
    expect(detailSource).toContain('navigateCard(dispatch.targetCardId)');
    expect(detailSource).toContain('navigateCard(dispatch.parentCardId)');
  });

  it('renders loading and failure from selected-detail state only', () => {
    expect(detailSource).toContain('v-if="currentDetailLoading"');
    expect(detailSource).toContain('v-else-if="detailError"');
    expect(detailSource).not.toMatch(/\bloading,\s*\n/);
  });

  it('surfaces record outputs through the dedicated records section', () => {
    expect(detailSource).toContain('<CardRecordsSection :card-id="currentCard.id" />');
    expect(recordsSource).toContain('DocumentFrame');
    expect(recordsSource).toContain('<MarkdownText v-else-if="stateValue(slot.key).content" :source="stateValue(slot.key).content || \'\'" />');
    expect(recordsSource).toContain("key: 'brief'");
    expect(recordsSource).toContain("key: 'status'");
    expect(recordsSource).toContain("key: 'review'");
  });

  it('demotes version history into a secondary, lazily mounted disclosure', () => {
    expect(detailSource).toContain('Version history');
    expect(detailSource).toContain('CardHistoryPanel v-if="historyOpen"');
  });

  it('surfaces agent conversations tied to the card', () => {
    expect(detailSource).toContain('CardConversationsSection');
  });

  it('does not expose direct card mutation controls or store actions', () => {
    expect(detailSource).not.toMatch(/createCard|updateCard|deleteCard|restartCard|abortSubtree|mark.*correction/i);
    expect(detailSource).not.toMatch(/@click="[^\"]*(?:save|delete|restart|abort|correction)/i);
    expect(detailSource).not.toMatch(/class="[^"]*(?:save|delete|restart|abort|correction)[^"]*"/i);
    expect(detailSource).not.toMatch(/@submit/);
  });
});

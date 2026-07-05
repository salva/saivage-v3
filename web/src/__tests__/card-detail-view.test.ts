import { describe, expect, it } from 'vitest';
import detailSource from '../components/cards/CardDetailView.vue?raw';
import recordsSource from '../components/cards/CardRecordsSection.vue?raw';

describe('CardDetailView S06 read-only detail contract', () => {
  it('retains navigation, refresh, record-output, and analyst-seed affordances', () => {
    expect(detailSource).toContain('Discuss with analyst');
    expect(detailSource).toContain('seedAnalystForCard');
    expect(detailSource).toContain('Refresh card');
    expect(detailSource).toContain('reloadDetail');
    expect(detailSource).toContain('navigateCard(child.id)');
  });

  it('surfaces record outputs through the dedicated records section', () => {
    expect(detailSource).toContain('CardRecordsSection');
    expect(recordsSource).toContain('DocumentFrame');
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

  it('uses an in-app confirmation before replacing an existing analyst draft', () => {
    expect(detailSource).toContain('confirmSeedVisible');
    expect(detailSource).toContain('Replace Analyst draft?');
    expect(detailSource).not.toContain('window.confirm');
  });

  it('does not expose direct card mutation controls or store actions', () => {
    expect(detailSource).not.toMatch(/createCard|updateCard|deleteCard|restartCard|abortSubtree|mark.*correction/i);
    expect(detailSource).not.toMatch(/@click="[^\"]*(?:save|delete|restart|abort|correction)/i);
    expect(detailSource).not.toMatch(/class="[^"]*(?:save|delete|restart|abort|correction)[^"]*"/i);
    expect(detailSource).not.toMatch(/@submit/);
  });
});

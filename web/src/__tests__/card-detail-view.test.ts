import { describe, expect, it } from 'vitest';
import source from '../components/cards/CardDetailView.vue?raw';

describe('CardDetailView S06 read-only detail contract', () => {
  it('retains navigation, refresh, record-output, and analyst-seed affordances', () => {
    expect(source).toContain('Discuss with analyst');
    expect(source).toContain('seedAnalystForCard');
    expect(source).toContain('Refresh card');
    expect(source).toContain('reloadDetail');
    expect(source).toContain('navigateCard(child.id)');
    expect(source).toContain('Record outputs');
    expect(source).toContain('.saivage/outputs/cards/{{ currentCard.id }}/');
  });

  it('does not expose direct card mutation controls or store actions', () => {
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|restartCard|abortSubtree|mark.*correction/i);
    expect(source).not.toMatch(/@click="[^\"]*(?:save|delete|restart|abort|correction)/i);
    expect(source).not.toMatch(/class="[^"]*(?:save|delete|restart|abort|correction)[^"]*"/i);
    expect(source).not.toMatch(/@submit/);
  });
});

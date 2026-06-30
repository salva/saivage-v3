import { describe, expect, it } from 'vitest';
import source from '../views/CardsView.vue?raw';

describe('CardsView S06 read-only mutation removal', () => {
  it('keeps only the passive tree controls while removing card mutation and filter affordances', () => {
    expect(source).toContain('Card Tree');
    expect(source).toContain('Open Timeline');
    expect(source).toContain('@toggle="toggleTreeNode"');
    expect(source).toContain('@select="selectCard"');
    expect(source).not.toContain('Search cards');
    expect(source).not.toContain('All Statuses');
    expect(source).not.toContain('All Types');
    expect(source).not.toContain('All Tags');
    expect(source).not.toContain('view-tab');

    expect(source).not.toMatch(/new card|create card|delete card|action-menu|delete-draft/i);
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|newTitle|newPriority|creating/);
    expect(source).not.toMatch(/@drop|@dragstart|@dragover|handleKeydown/);
  });
});

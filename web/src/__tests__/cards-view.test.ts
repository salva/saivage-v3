import { describe, expect, it } from 'vitest';
import source from '../views/CardsView.vue?raw';

describe('CardsView read-only navigation contract', () => {
  it('keeps passive tree controls and read-only filters, with no mutation affordances', () => {
    expect(source).toContain('@toggle="toggleTreeNode"');
    expect(source).toContain('@select="selectCard"');
    expect(source).toContain('filterStatus');
    expect(source).toContain('filterType');
    expect(source).toContain('searchQuery');
    expect(source).toContain('clearFilters');

    expect(source).not.toContain('Card Tree');
    expect(source).not.toContain('Open Timeline');
    expect(source).not.toContain('view-tab');

    expect(source).not.toMatch(/new card|create card|delete card|action-menu|delete-draft/i);
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|newTitle|newPriority|creating/);
    expect(source).not.toMatch(/@drop|@dragstart|@dragover|handleKeydown/);
  });
});

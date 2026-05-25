import { describe, expect, it } from 'vitest';
import source from '../views/CardsView.vue?raw';

describe('CardsView S06 read-only mutation removal', () => {
  it('keeps passive list controls while removing card mutation affordances', () => {
    expect(source).toContain('Search cards');
    expect(source).toContain('All Statuses');
    expect(source).toContain('All Types');
    expect(source).toContain('All Tags');
    expect(source).toContain('@toggle="toggleTreeNode"');
    expect(source).toContain('@select="selectCard"');

    expect(source).not.toMatch(/new card|create card|delete card|action-menu|delete-draft/i);
    expect(source).not.toMatch(/createCard|updateCard|deleteCard|newTitle|newPriority|creating/);
    expect(source).not.toMatch(/@drop|@dragstart|@dragover|handleKeydown/);
  });
});

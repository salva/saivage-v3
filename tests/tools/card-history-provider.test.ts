import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { createCardHistoryProvider } from '../../src/tools/card-history-provider.js';
import { invokeTool } from '../../src/tools/invocation.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card history provider', () => {
  it('validates numeric inputs before executors and calls only named history resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-tool-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const card = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.editCard(card.id, { title: 'Card v2' });
    const list = jest.spyOn(cards, 'listCardHistory');
    const get = jest.spyOn(cards, 'getCardHistoryEntry');
    const diff = jest.spyOn(cards, 'diffCardHistory');
    const read = jest.spyOn(cards, 'read');
    const provider = createCardHistoryProvider({ store: cards });
    const surface = buildInvocationSurfaceFixture('analyst', [provider]);

    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await invokeTool(surface, 'get_card_history_entry', { cardId: card.id, version_seq: invalid })).success).toBe(false);
      expect((await invokeTool(surface, 'diff_card', { cardId: card.id, fromSeq: invalid })).success).toBe(false);
      expect((await invokeTool(surface, 'diff_card', { cardId: card.id, toSeq: invalid })).success).toBe(false);
    }
    expect(list).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(diff).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();

    expect((await invokeTool(surface, 'list_card_history', { cardId: card.id })).success).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
    expect((await invokeTool(surface, 'get_card_history_entry', { cardId: card.id, version_seq: 1 })).success).toBe(true);
    expect(get).toHaveBeenCalledWith(card.id, 1);
    expect((await invokeTool(surface, 'diff_card', { cardId: card.id, fromSeq: 1, toSeq: 2 })).success).toBe(true);
    expect(diff).toHaveBeenCalledWith(card.id, { fromSeq: 1, toSeq: 2 });
    expect(read).not.toHaveBeenCalled();
  });
});

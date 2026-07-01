import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { createCardHistoryProvider } from '../../src/tools/card-history-provider.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

function setup(root: string): CardStore {
  initProjectTree(root);
  materializeProjectCard(root);
  return new CardStore(root);
}

describe('CardHistoryProvider', () => {
  it('exposes card history tools through an invocation surface', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-provider-'));
    try {
      const store = setup(root);
      const surface = buildInvocationSurface('executor', [createCardHistoryProvider({ projectRoot: root, store, agentRole: 'executor' })]);
      expect([...surface.tools.keys()]).toEqual(['list_card_history', 'get_card_history_entry', 'diff_card']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns history data and model-visible missing-card errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-history-provider-'));
    try {
      const store = setup(root);
      const card = store.create({ type: 'code', parent: 'project', depth: 0, title: 'before', brief: 'brief', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [], retries: 0 } as never);
      store.mutateCard(card.id, { title: 'after' }, { actor: 'analyst', surface: 'web-chat', reason: 'test update' });
      const surface = buildInvocationSurface('executor', [createCardHistoryProvider({ projectRoot: root, store, agentRole: 'executor' })]);

      const history = await invokeTool(surface, 'list_card_history', { cardId: card.id });
      expect(history).toEqual(expect.objectContaining({ success: true }));
      if (history.success) expect(history.data).toEqual([expect.objectContaining({ card_id: card.id, version_seq: 1 })]);

      const missing = await invokeTool(surface, 'diff_card', { cardId: 'missing' });
      expect(missing).toEqual(expect.objectContaining({ success: false }));
      if (!missing.success) expect(missing.error).toContain("Card 'missing' not found");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

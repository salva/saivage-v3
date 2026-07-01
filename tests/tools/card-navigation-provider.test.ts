import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { createCardNavigationProvider } from '../../src/tools/card-navigation-provider.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

describe('CardNavigationProvider', () => {
  it('returns structured navigation intents through an invocation surface', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-navigation-provider-'));
    try {
      initProjectTree(root);
      materializeProjectCard(root);
      const store = new CardStore(root);
      const surface = buildInvocationSurface('analyst', [createCardNavigationProvider({ projectRoot: root, store, sessionId: 'session-1' })]);

      await expect(invokeTool(surface, 'navigate_workspace', { target: { kind: 'card', id: 'project' } })).resolves.toEqual({ success: true, data: { intent: 'navigate_workspace', target: { kind: 'card', id: 'project' } } });
      await expect(invokeTool(surface, 'navigate_back', {})).resolves.toEqual({ success: true, data: { intent: 'navigate_back' } });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

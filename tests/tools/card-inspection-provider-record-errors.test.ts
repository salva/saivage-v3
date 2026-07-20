import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { createCardInspectionProvider } from '../../src/tools/card-inspection-provider.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card inspection authored-record summaries', () => {
  it('does not normalize a strict record read failure into empty slot metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-inspection-record-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const normalSurface = buildInvocationSurface('analyst', [createCardInspectionProvider({ store: cards })]);
    await expect(invokeTool(normalSurface, 'get_card', { id: 'project' })).resolves.toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ records_by_filename: expect.objectContaining({ 'status.md': expect.objectContaining({ latest: null }), 'review.md': expect.objectContaining({ latest: null }) }) }) }));

    const hostile = new Error('HOSTILE_CARD_INSPECTION_READ');
    cards.readRecord = (() => { throw hostile; }) as CardService['readRecord'];
    const surface = buildInvocationSurface('analyst', [createCardInspectionProvider({ store: cards })]);

    await expect(invokeTool(surface, 'get_card', { id: 'project' })).rejects.toBe(hostile);
  });
});

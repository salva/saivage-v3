import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { bindToolProvider, invokeTool } from '../../src/tools/invocation.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card inspection authored-record summaries', () => {
  it('does not normalize a strict record read failure into empty slot metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-inspection-record-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const normalSurface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards,cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] })]);
    const result = await invokeTool(normalSurface, 'get_card', { id: 'project' });
    expect(result).toEqual(expect.objectContaining({ success: true, data: expect.objectContaining({ records_by_filename: expect.objectContaining({ 'status.md': expect.objectContaining({ state: 'absent', head_version: null }), 'review.md': expect.objectContaining({ state: 'absent', head_version: null }) }) }) }));
    const data = result.data as { records: Array<{ name: string }>; records_by_filename: Record<string, unknown> };
    expect(data.records.map(({ name }) => name)).toEqual(['brief.md', 'status.md', 'review.md']);
    expect(Object.keys(data.records_by_filename)).toEqual(['brief.md', 'status.md', 'review.md']);

    const hostile = new Error('HOSTILE_CARD_INSPECTION_READ');
    cards.readCurrentRecord = (() => { throw hostile; }) as CardService['readCurrentRecord'];
    const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards,cardTypeVocabulary:['project','goal','architecture','code','test','doc','data','research','ops'] })]);

    await expect(invokeTool(surface, 'get_card', { id: 'project' })).rejects.toBe(hostile);
  });
});

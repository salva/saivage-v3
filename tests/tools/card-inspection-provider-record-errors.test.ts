import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';

import { invokeTestTool } from '../helpers/invoke-test-tool.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card inspection authored-record summaries', () => {
  it('does not normalize a strict record read failure into empty slot metadata', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-inspection-record-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const normalSurface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary: ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] })]);
    const result = await invokeTestTool(normalSurface, 'get_card', { id: 'project', section: 'records' });
    const data = result.data as { content: { items: Array<{ name: string; state: string; head_version: number | null; head_entry_id: string | null; version_url: string | null }> } };
    expect(data.content.items.map(({ name }) => name)).toEqual(['brief.md', 'status.md', 'review.md']);
    expect(data.content.items.filter((item) => item.state === 'absent')).toHaveLength(2);
    const brief = data.content.items[0]!;
    expect(brief.state).toBe('closed');
    expect(brief.head_version).toBe(1);
    expect(brief.head_entry_id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(brief.version_url).toBe(`record:///brief.md?card=project&v=1`);

    const hostile = new Error('HOSTILE_CARD_INSPECTION_READ');
    cards.listDeclaredRecordMetadata = (() => { throw hostile; }) as CardService['listDeclaredRecordMetadata'];
    const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary: ['project', 'goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] })]);

    await expect(invokeTestTool(surface, 'get_card', { id: 'project', section: 'records' })).rejects.toBe(hostile);
  });
});

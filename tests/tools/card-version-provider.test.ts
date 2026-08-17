import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardVersionToolBinders } from '../../src/tools/card-version-provider.js';
import { bindToolProvider, invokeTool } from '../../src/tools/invocation.js';
import { cardVersionIndexFile, cardVersionFile } from '../../src/persistence/layout.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('card version provider', () => {
  it('lists index metadata and reads and diffs exact resulting versions', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Before', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    cards.editCard(child.id, { title: 'After' }, 'planner');
    const surface = buildInvocationSurfaceFixture('planner', [bindToolProvider('card-version', cardVersionToolBinders, { store: cards })]);

    await expect(invokeTool(surface, 'list_card_versions', { card_id: child.id })).resolves.toMatchObject({ success: true, data: { card_id: child.id, total: 2, versions: [{ version: 1, content_availability: 'unchecked' }, { version: 2, content_availability: 'unchecked' }] } });
    await expect(invokeTool(surface, 'get_card_version', { card_id: child.id, version: 2 })).resolves.toMatchObject({ success: true, data: { card_id: child.id, version: 2, artifact: { kind: 'card-version', card: { title: 'After' } } } });
    await expect(invokeTool(surface, 'diff_card_versions', { card_id: child.id, from_version: 1, to_version: 2 })).resolves.toMatchObject({ success: true, data: { card_id: child.id, from: 1, to: 2, diff: expect.arrayContaining([expect.objectContaining({ field: 'title', before: 'Before', after: 'After' })]) } });
  });

  it('keeps list metadata available when selected historical content is missing', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-version-tool-missing-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Card', bootstrap_content: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    const index = JSON.parse(readFileSync(cardVersionIndexFile(root, child.id), 'utf8')) as { versions: Array<{ filename: string }> };
    rmSync(cardVersionFile(root, child.id, index.versions[0]!.filename));
    const surface = buildInvocationSurfaceFixture('planner', [bindToolProvider('card-version', cardVersionToolBinders, { store: cards })]);

    await expect(invokeTool(surface, 'list_card_versions', { card_id: child.id })).resolves.toMatchObject({ success: true, data: { total: 1 } });
    await expect(invokeTool(surface, 'get_card_version', { card_id: child.id, version: 1 })).resolves.toEqual({ success: false, error: 'Historical card version content unavailable.', data: { code: 'historical_version_content_unavailable', resource: 'card', owner_id: child.id, version: 1, reason: 'missing' } });
  });
});

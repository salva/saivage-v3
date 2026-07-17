import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import { invokeToolForLlm } from '../../src/tools/invocation.js';
import { buildRoleSurface } from '../../src/tools/role-invocation-surfaces.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const CHILD_SEGMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD = `card-${CHILD_SEGMENT}`;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function closeRecord(store: CardService, cardId: string, filename: string, content: string, writer: 'executor' | 'reviewer'): void {
  const open = store.openRecord(cardId, filename);
  store.editRecord(cardId, filename, open.version, content);
  store.closeRecord(cardId, filename, open.version, writer, store.read(cardId)!.version_seq);
}

describe('reviewer role surface record access', () => {
  it('reads canonical closed descendant records and only the owning open review record', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reviewer-role-surface-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const store = new CardService(projectRoot, undefined, undefined, () => CHILD_SEGMENT);
    store.create({ type: 'code', parent: 'project', title: 'Reviewed child', brief: 'Produce review evidence.', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [] });
    closeRecord(store, CHILD, 'status.md', 'First closed descendant status.', 'executor');
    closeRecord(store, CHILD, 'status.md', 'Latest closed descendant status.', 'executor');

    const surface = buildRoleSurface('reviewer', {
      projectRoot,
      cardId: 'project',
      sessionId: 'reviewer:project',
      store,
      mcpManagerProvider: () => undefined,
    });

    await expect(invokeToolForLlm(surface, 'read', { path: `record:///status.md?card=${CHILD}&v=1` })).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        path: `record:///status.md?card=${CHILD}&v=1`,
        record_url: `record:///status.md?card=${CHILD}&v=1`,
        content: 'First closed descendant status.',
      }),
    });
    await expect(invokeToolForLlm(surface, 'read', { path: `record:///status.md?card=${CHILD}&v=latest` })).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        path: `record:///status.md?card=${CHILD}&v=2`,
        record_url: `record:///status.md?card=${CHILD}&v=2`,
        content: 'Latest closed descendant status.',
      }),
    });

    await expect(invokeToolForLlm(surface, 'write', { path: 'record:///review.md?v=next', content: 'Review draft.' })).resolves.toEqual({
      success: true,
      data: { path: 'record:///review.md?card=project&v=1', record_url: 'record:///review.md?card=project&v=1', bytes: 13, written: true },
    });
    await expect(invokeToolForLlm(surface, 'read', { path: 'record:///review.md?v=next' })).resolves.toEqual({
      success: true,
      data: expect.objectContaining({
        path: 'record:///review.md?card=project&v=1',
        record_url: 'record:///review.md?card=project&v=1',
        content: 'Review draft.',
      }),
    });

    const foreignOpen = store.openRecord(CHILD, 'status.md');
    store.editRecord(CHILD, 'status.md', foreignOpen.version, 'Unclosed descendant draft.');
    await expect(invokeToolForLlm(surface, 'read', { path: `record:///status.md?card=${CHILD}&v=next` })).resolves.toMatchObject({
      success: false,
      error: 'Only the owning agent may read its current open record slot.',
    });
    await expect(invokeToolForLlm(surface, 'read', { path: `record://status.md?card=${CHILD}&v=1` })).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining('expected record:///'),
    });
  });
});

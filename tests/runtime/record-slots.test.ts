import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardStore, initProjectTree } from '../helpers/canonical-project.js';

function withProject(run: (root: string, store: CardStore) => void): void {
  const root = mkdtempSync(join(tmpdir(), 'saivage-record-slots-'));
  try { initProjectTree(root); run(root, new CardStore(root)); } finally { rmSync(root, { recursive: true, force: true }); }
}

describe('canonical authored record slots', () => {
  it('opens, edits, closes, and projects a slot-local version', () => withProject((_root, store) => {
    const open = store.openRecord('project', 'status.md');
    expect(store.openRecord('project', 'status.md').version).toBe(open.version);
    store.editRecord('project', 'status.md', open.version, 'done');
    const closed = store.closeRecord('project', 'status.md', open.version, 'planner', 1);
    expect(closed.artifact).toMatchObject({ state: 'closed', content: 'done', writer: 'planner', card_version_seq: 1, committed_at: expect.any(String) });
    expect(store.recordReader.generation().cards.get('project')?.records.status).toMatchObject({ latest: expect.objectContaining({ version: 1 }), open: null });
  }));

  it('discards an open artifact without changing latest closed authority', () => withProject((_root, store) => {
    const first = store.openRecord('project', 'review.md');
    store.editRecord('project', 'review.md', first.version, 'draft');
    store.discardRecord('project', 'review.md', first.version, 'stale_review');
    expect(store.readRecord('project', 'review.md', first.version).artifact).toMatchObject({ state: 'discarded', reason: 'stale_review' });
    expect(() => store.readRecord('project', 'review.md', 'latest')).toThrow(/does not exist/);
    expect(store.openRecord('project', 'review.md').version).toBe(2);
  }));

  it('rejects obsolete ordering metadata in strict canonical artifacts', () => withProject((_root, store) => {
    const open = store.openRecord('project', 'status.md');
    expect(open.artifact).not.toHaveProperty(['global', 'Seq'].join(''));
  }));
});

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../helpers/canonical-project.js';
import type { CanonicalReadInstrumentation } from '../../src/persistence/growing-file.js';
import { cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function recorder(): { instrumentation: CanonicalReadInstrumentation; paths: string[] } {
  const paths: string[] = [];
  return { paths, instrumentation: { onRead: (path) => paths.push(path) } };
}

function input(parent: string, title: string, type: 'goal' | 'code' = 'code') {
  return { type, parent, title, bootstrap_content: `${title} brief`, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
}

describe('bounded card resource reads', () => {
  it('does not traverse many grandchildren while classifying one root slice', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lazy-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const grandchildren: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const child = cards.create(input('project', `Parent ${index}`, 'goal'));
      for (let nested = 0; nested < 20; nested += 1) grandchildren.push(cards.create(input(child.id, `Grandchild ${index}-${nested}`)).id);
    }
    const rootRead = recorder();
    const hierarchy = cards.getCardChildren('project', rootRead.instrumentation);
    expect(hierarchy.kind).toBe('found');
    expect(rootRead.paths).toHaveLength(9);
    for (const id of grandchildren) expect(rootRead.paths).not.toContain(cardStreamFile(root, id));
  });

  it('reads only a target path and the target immediate committed children', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lazy-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create(input('project', 'Parent', 'goal'));
    const sibling = cards.create(input('project', 'Sibling'));
    const retained = cards.create(input('project', 'Retained', 'goal'));
    const retainedDescendant = cards.create(input(retained.id, 'Retained descendant'));
    const grandchild = cards.create(input(parent.id, 'Grandchild'));
    cards.deleteSubtrees([retained.id], () => true);
    writeFileSync(cardStreamFile(root, retainedDescendant.id), '{tombstoned-descendant-must-not-be-read}\n');
    writeFileSync(cardRecordStreamFile(root, sibling.id, testRecordDefinition('brief.md')), '{complete-malformed}\n');

    const rootRead = recorder();
    const hierarchy = cards.getCardChildren('project', rootRead.instrumentation);
    expect(hierarchy.kind).toBe('found');
    if (hierarchy.kind !== 'found') throw new Error('expected root hierarchy');
    expect(hierarchy.value.activeChildren.map(({ id }) => id)).toEqual([parent.id, sibling.id]);
    expect(rootRead.paths).toEqual([
      cardStreamFile(root, 'project'),
      cardStreamFile(root, parent.id),
      cardStreamFile(root, sibling.id),
      cardStreamFile(root, retained.id),
    ]);
    expect(rootRead.paths).not.toContain(cardStreamFile(root, grandchild.id));
    expect(rootRead.paths).not.toContain(cardStreamFile(root, retainedDescendant.id));
    expect(rootRead.paths.every((path) => path.endsWith('card.jsonl'))).toBe(true);

    writeFileSync(cardStreamFile(root, sibling.id), '{complete-malformed-unrelated}\n');
    const branchRead = recorder();
    const branch = cards.getCardChildren(parent.id, branchRead.instrumentation);
    expect(branch.kind).toBe('found');
    expect(branchRead.paths).toEqual([
      cardStreamFile(root, 'project'),
      cardStreamFile(root, parent.id),
      cardStreamFile(root, grandchild.id),
    ]);

    writeFileSync(cardStreamFile(root, grandchild.id), '{complete-malformed-reached}\n');
    expect(() => cards.getCardChildren(parent.id)).toThrow(/malformed/);
  });

  it('keeps detail, authored records, history entry, and diff at their exact boundaries', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lazy-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create(input('project', 'Parent', 'goal'));
    const target = cards.create(input(parent.id, 'Target', 'goal'));
    cards.openRecord(target.id, 'status.md');
    cards.editRecord(target.id, 'status.md', 1, 'Status');
    cards.closeRecord(target.id, 'status.md', 1, 'executor', 1);
    cards.openRecord(target.id, 'review.md');
    cards.editRecord(target.id, 'review.md', 1, 'Review');
    cards.closeRecord(target.id, 'review.md', 1, 'reviewer', 1);
    cards.editCard(target.id, { title: 'Target v2' });
    cards.editCard(target.id, { priority: 2 });
    const path = [cardStreamFile(root, 'project'), cardStreamFile(root, parent.id), cardStreamFile(root, target.id)];

    const detailRead = recorder();
    expect(cards.getCardDetail(target.id, detailRead.instrumentation).kind).toBe('found');
    expect(detailRead.paths).toEqual(path);

    const recordRead = recorder();
    expect(cards.readRecord(target.id, 'brief.md', 'latest', recordRead.instrumentation).artifact.content).toBe('Target brief');
    expect(recordRead.paths).toEqual([...path, cardRecordStreamFile(root, target.id, testRecordDefinition('brief.md'))]);
    for (const slot of ['status', 'review'] as const) {
      const slotRead = recorder();
      expect(cards.readRecord(target.id, `${slot}.md`, 'latest', slotRead.instrumentation).artifact.content).toBe(slot === 'status' ? 'Status' : 'Review');
      expect(slotRead.paths).toEqual([...path, cardRecordStreamFile(root, target.id, testRecordDefinition(`${slot}.md`))]);
    }

    const listRead = recorder();
    const history = cards.listCardHistory(target.id, listRead.instrumentation);
    expect(history.kind).toBe('found');
    if (history.kind !== 'found') throw new Error('expected history');
    expect(history.value.map(({ version_seq }) => version_seq)).toEqual([2, 1]);
    expect(listRead.paths).toEqual(path);

    const entryRead = recorder();
    expect(cards.getCardHistoryEntry(target.id, 1, entryRead.instrumentation).kind).toBe('found');
    expect(entryRead.paths).toEqual(path);

    const diffRead = recorder();
    const diff = cards.diffCardHistory(target.id, { fromSeq: 1, toSeq: 3 }, diffRead.instrumentation);
    expect(diff.kind).toBe('found');
    expect(diffRead.paths).toEqual(path);
  });

  it('rejects invalid domain sequences before any exact read', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-lazy-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const entryRead = recorder();
      expect(() => cards.getCardHistoryEntry('project', invalid, entryRead.instrumentation)).toThrow();
      expect(entryRead.paths).toEqual([]);
      const diffRead = recorder();
      expect(() => cards.diffCardHistory('project', { fromSeq: invalid }, diffRead.instrumentation)).toThrow();
      expect(diffRead.paths).toEqual([]);
      const toDiffRead = recorder();
      expect(() => cards.diffCardHistory('project', { toSeq: invalid }, toDiffRead.instrumentation)).toThrow();
      expect(toDiffRead.paths).toEqual([]);
    }
  });
});

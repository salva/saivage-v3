import { afterEach, describe, expect, it } from '@jest/globals';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService, initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { cardRecordSchema, type CardRecord } from '../../src/schemas/index.js';
import { cardVersionChangeSchema } from '../../src/schemas/card-version-change.js';
import { publishCardVersion, publishInitialChildCard } from '../../src/persistence/card-files.js';
import { cardStreamFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function project(): { root: string; cards: CardService } {
  const root = mkdtempSync(join(tmpdir(), 'card-relationship-reads-'));
  roots.push(root);
  initProjectTree(root);
  return { root, cards: new CardService(root) };
}

function input(parent: string, type: 'goal' | 'code' = 'code', depends_on: string[] = []) {
  return { type, parent, title: `${parent} child`, bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on, related: [] };
}

function link(root: string, parent: CardRecord, childId: string): CardRecord {
  const changedAt = new Date().toISOString();
  const next = cardRecordSchema.parse({ ...parent, children: [...parent.children, childId], version_seq: parent.version_seq + 1, updated_at: changedAt });
  const change = cardVersionChangeSchema.parse({ entry_id: randomUUID(), kind: 'child_link', card_id: parent.id, resulting_version: next.version_seq, changed_at: changedAt, changed_by_actor: 'runtime', changed_by_surface: 'runtime', changed_fields: ['children'], change_summary: `linked child ${childId}`, change_reason: 'child linked', terminal_summary: null });
  publishCardVersion(root, next, change);
  return next;
}

function publishLinked(root: string, parent: CardRecord, dependsOn: string[]): { parent: CardRecord; child: CardRecord } {
  const child = publishInitialChildCard(root, input(parent.id, 'code', dependsOn), TEST_WORKFLOWS.cardTypes.get('code')!);
  return { parent: link(root, parent, child.id), child };
}

function corruptCurrent(root: string, id: string): void {
  const path = cardStreamFile(root, id);
  const envelopes = readFileSync(path, 'utf8').trimEnd().split('\n');
  envelopes[envelopes.length - 1] = '{bad json}';
  writeFileSync(path, `${envelopes.join('\n')}\n`);
}

describe('CardService scoped relationship reads', () => {
  it('preserves relationship semantics and committed preorder', () => {
    const { cards } = project();
    const goal = cards.create(input('project', 'goal'));
    const first = cards.create(input(goal.id, 'goal'));
    const nested = cards.create(input(first.id));
    const second = cards.create(input(goal.id, 'code', [first.id]));

    expect(cards.getParent('project')).toBeNull();
    expect(cards.getParent(nested.id)).toBe(first.id);
    expect(cards.getAncestors(nested.id)).toEqual(['project', goal.id, first.id]);
    expect(cards.getDescendantIds(goal.id)).toEqual([first.id, nested.id, second.id]);
    expect(cards.list().map((card) => card.id)).toEqual(['project', goal.id, first.id, second.id, nested.id]);
  });

  it('returns operation-specific absence for well-formed inactive targets and rejects every malformed ID', () => {
    const { cards } = project();
    expect(cards.getParent('card-z')).toBeNull();
    expect(cards.getAncestors('card-z')).toEqual([]);
    expect(cards.getDescendantIds('card-z')).toEqual([]);
    for (const call of [
      () => cards.getParent('bad'), () => cards.getAncestors('bad'), () => cards.getDescendantIds('bad'),
    ]) expect(call).toThrow();
  });

  it('fails on reached malformed state but ignores an unrelated malformed linked branch', () => {
    const { root, cards } = project();
    const healthy = cards.create(input('project', 'goal'));
    const reached = cards.create(input(healthy.id));
    const unrelated = cards.create(input('project'));
    corruptCurrent(root, unrelated.id);

    expect(cards.getParent(reached.id)).toBe(healthy.id);
    expect(cards.getAncestors(reached.id)).toEqual(['project', healthy.id]);
    expect(cards.getDescendantIds(healthy.id)).toEqual([reached.id]);
    expect(() => cards.list()).toThrow();
    corruptCurrent(root, reached.id);
    expect(() => cards.getParent(reached.id)).toThrow();
    expect(() => cards.getDescendantIds(healthy.id)).toThrow();
  });

  it('does not validate missing dependencies on reached cards while full projections reject them', () => {
    const { root, cards } = project();
    let rootCard = cards.read('project')!;
    const goalPublished = publishLinked(root, rootCard, ['card-z']); rootCard = goalPublished.parent;
    const childPublished = publishLinked(root, goalPublished.child, ['card-z']);

    expect(cards.getParent(goalPublished.child.id)).toBe('project');
    expect(cards.getAncestors(goalPublished.child.id)).toEqual(['project']);
    expect(cards.getDescendantIds(goalPublished.child.id)).toEqual([childPublished.child.id]);
    expect(() => cards.list()).toThrow(/depends_on missing card 'card-z'/);
    expect(rootCard.children).toContain(goalPublished.child.id);
  });

  it('does not validate reached dependency cycles while full projections reject them', () => {
    const { root, cards } = project();
    let rootCard = cards.read('project')!;
    const first = publishLinked(root, rootCard, ['card-b']); rootCard = first.parent;
    const second = publishLinked(root, rootCard, [first.child.id]);

    expect(first.child.id).toBe('card-a');
    expect(second.child.id).toBe('card-b');
    expect(cards.getParent(first.child.id)).toBe('project');
    expect(cards.getAncestors(second.child.id)).toEqual(['project']);
    expect(cards.getDescendantIds('project')).toEqual([first.child.id, second.child.id]);
    expect(() => cards.list()).toThrow(/dependency graph contains a cycle/);
  });

  it('isolates healthy relationships from schema-valid dependency errors in another branch', () => {
    const { root, cards } = project();
    let rootCard = cards.read('project')!;
    const healthy = publishLinked(root, rootCard, []); rootCard = healthy.parent;
    publishLinked(root, rootCard, ['card-z']);

    expect(cards.getParent(healthy.child.id)).toBe('project');
    expect(cards.getAncestors(healthy.child.id)).toEqual(['project']);
    expect(cards.getDescendantIds(healthy.child.id)).toEqual([]);
    expect(() => cards.list()).toThrow(/depends_on missing card 'card-z'/);
  });

  it('isolates healthy relationships from a schema-valid dependency cycle in another branch', () => {
    const { root, cards } = project();
    let rootCard = cards.read('project')!;
    const healthy = publishLinked(root, rootCard, []); rootCard = healthy.parent;
    const firstCycle = publishLinked(root, rootCard, ['card-c']); rootCard = firstCycle.parent;
    const secondCycle = publishLinked(root, rootCard, [firstCycle.child.id]);

    expect(firstCycle.child.id).toBe('card-b');
    expect(secondCycle.child.id).toBe('card-c');
    expect(cards.getParent(healthy.child.id)).toBe('project');
    expect(cards.getAncestors(healthy.child.id)).toEqual(['project']);
    expect(cards.getDescendantIds(healthy.child.id)).toEqual([]);
    expect(() => cards.list()).toThrow(/dependency graph contains a cycle/);
  });
});

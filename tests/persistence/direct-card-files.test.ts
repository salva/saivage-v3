import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { readCard, readLinkedChildren } from '../../src/persistence/card-files.js';
import { cardNamespace, cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('exact hierarchical card files', () => {
  it('publishes exact streams and cumulative parent membership', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const segment = 'a';
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    expect(child.id).toBe(`card-${segment}`);
    expect(cardNamespace(root, child.id)).toBe(join(root, '.saivage', 'cards', 'project', 'children', segment));
    expect(cards.read('project')!.children).toEqual([child.id]);
    expect(readFileSync(cardStreamFile(root, child.id), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('projects active children in exact committed parent order while retaining tombstoned links', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create({ type: 'code', parent: 'project', title: 'First', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const retained = cards.create({ type: 'code', parent: 'project', title: 'Retained', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', title: 'Second', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.deleteSubtrees([retained.id], { actor: 'analyst', surface: 'runtime' }, () => true);
    cards.reorderChildren('project', [second.id, first.id], { actor: 'analyst', surface: 'runtime' });

    expect(readCard(root, 'project')?.children).toEqual([second.id, first.id, retained.id]);
    expect(readLinkedChildren(root, 'project').map(({ id }) => id)).toEqual([second.id, first.id]);
  });

  it('fails on a complete unsupported row kind in the exact parent stream', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const path = cardStreamFile(root, 'project');
    const malformed = { version: 1, type: 'rows', rows: [{ kind: 'unsupported-card-row', format_version: 1, card_id: 'project' }] };
    writeFileSync(path, `${readFileSync(path, 'utf8')}${JSON.stringify(malformed)}\n`);

    expect(() => readCard(root, 'project')).toThrow(/malformed/);
  });

  it('does not touch unlinked malformed or symlink child namespaces', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const orphan = join(root, '.saivage', 'cards', 'project', 'children', 'b');
    mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'card.jsonl'), '{complete-malformed}\n');
    expect(readCard(root, 'card-b')).toBeNull();
    rmSync(orphan, { recursive: true }); symlinkSync(root, orphan);
    expect(readCard(root, 'card-b')).toBeNull();
  });

  it('keeps every card-domain read opaque after target tombstone and stops before descendants', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.deleteSubtrees([parent.id], { actor: 'analyst', surface: 'runtime', reason: 'test deletion' }, () => true);

    expect(readCard(root, parent.id)).toBeNull();
    expect(cards.listCardHistory(parent.id)).toEqual({ kind: 'card-not-found' });
    expect(cards.getCardHistoryEntry(parent.id, 1)).toEqual({ kind: 'card-not-found' });
    expect(cards.diffCardHistory(parent.id, { fromSeq: 1, toSeq: 2 })).toEqual({ kind: 'card-not-found' });
    expect(() => cards.readRecord(parent.id, 'brief.md')).toThrow(`Card '${parent.id}' does not exist.`);

    writeFileSync(cardStreamFile(root, child.id), '{complete-malformed}\n');
    expect(readCard(root, child.id)).toBeNull();
    expect(cards.listCardHistory(child.id)).toEqual({ kind: 'card-not-found' });
  });

  it('does not couple a card-only read to the active root brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    rmSync(cardRecordStreamFile(root, 'project', 'brief'));
    expect(readCard(root, 'project')?.id).toBe('project');
  });

  it('does not read ancestor briefs while proving an active target path', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    writeFileSync(cardRecordStreamFile(root, parent.id, 'brief'), '{complete-malformed}\n');
    expect(readCard(root, child.id)?.id).toBe(child.id);
  });

  it('does not couple a card-only target read to its brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    rmSync(cardRecordStreamFile(root, child.id, 'brief'));
    expect(readCard(root, child.id)?.id).toBe(child.id);
  });
});

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { readCard } from '../../src/persistence/card-files.js';
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

  it('fails on a complete malformed reservation row in the exact parent stream', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const path = cardStreamFile(root, 'project');
    const malformed = { version: 1, type: 'rows', rows: [{ kind: 'card-child-reservation', format_version: 1, card_id: 'project', segment: 'a', child_id: 'card-a', extra: true }] };
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
    expect(() => cards.listCardHistory(parent.id)).toThrow(`Card '${parent.id}' does not exist.`);
    expect(() => cards.getCardAt(parent.id, 1)).toThrow(`Card '${parent.id}' does not exist.`);
    expect(() => cards.diffCard(parent.id, 1, 2)).toThrow(`Card '${parent.id}' does not exist.`);
    expect(() => cards.readRecord(parent.id, 'brief.md')).toThrow(`Card '${parent.id}' does not exist.`);

    writeFileSync(cardStreamFile(root, child.id), '{complete-malformed}\n');
    expect(readCard(root, child.id)).toBeNull();
    expect(() => cards.listCardHistory(child.id)).toThrow(`Card '${child.id}' does not exist.`);
  });

  it('requires the exact brief for the active root', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    rmSync(cardRecordStreamFile(root, 'project', 'brief'));
    expect(() => readCard(root, 'project')).toThrow();
  });

  it('requires exact briefs for active ancestors before touching the target', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    writeFileSync(cardRecordStreamFile(root, parent.id, 'brief'), '{complete-malformed}\n');
    writeFileSync(cardStreamFile(root, child.id), '{prospective-target-must-not-be-read}\n');
    expect(() => readCard(root, child.id)).toThrow(/brief\.jsonl/);
  });

  it('requires the exact brief for an active target', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    rmSync(cardRecordStreamFile(root, child.id, 'brief'));
    expect(() => readCard(root, child.id)).toThrow();
  });
});

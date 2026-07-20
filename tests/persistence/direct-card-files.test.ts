import { afterEach, describe, expect, it } from '@jest/globals';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { readCanonicalCardHierarchy, readCard, readLinkedChildren } from '../../src/persistence/card-files.js';
import { cardNamespace, cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { AuthoredRecordNotFoundError } from '../../src/persistence/authored-record-files.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('exact hierarchical card files', () => {
  it('publishes exact streams and cumulative parent membership', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const segment = 'a';
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    expect(child.id).toBe(`card-${segment}`);
    expect(cardNamespace(root, child.id)).toBe(join(root, '.saivage', 'cards', 'project', 'children', segment));
    expect(cards.read('project')!.children).toEqual([child.id]);
    expect(readFileSync(cardStreamFile(root, child.id), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('projects active children in exact committed parent order while retaining tombstoned links', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const first = cards.create({ type: 'code', parent: 'project', title: 'First', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const retained = cards.create({ type: 'code', parent: 'project', title: 'Retained', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const second = cards.create({ type: 'code', parent: 'project', title: 'Second', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
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

  it('proves linkage before touching an unlinked outside child namespace', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const outside = mkdtempSync(join(tmpdir(), 'saivage-direct-card-outside-')); roots.push(outside);
    writeFileSync(join(outside, 'card.jsonl'), '{complete-malformed}\n');
    const children = join(root, '.saivage', 'cards', 'project', 'children');
    mkdirSync(children);
    symlinkSync(outside, join(children, 'z'));
    const reads: string[] = [];

    expect(readCard(root, 'card-z', { onRead: (stream) => reads.push(stream) })).toBeNull();
    expect(reads).toEqual([cardStreamFile(root, 'project')]);
  });

  it('rejects symlinked reached canonical ancestors before reading an outside stream', () => {
    const cases: Array<{ name: string; target: 'project' | 'child' | 'grandchild'; replace(root: string, childId: string, grandchildId: string, outside: string): void }> = [
      {
        name: '.saivage', target: 'project', replace(root, _childId, _grandchildId, outside) {
          renameSync(join(root, '.saivage'), join(outside, 'moved-saivage'));
          symlinkSync(join(outside, 'moved-saivage'), join(root, '.saivage'));
        },
      },
      {
        name: 'cards', target: 'project', replace(root, _childId, _grandchildId, outside) {
          renameSync(join(root, '.saivage', 'cards'), join(outside, 'moved-cards'));
          symlinkSync(join(outside, 'moved-cards'), join(root, '.saivage', 'cards'));
        },
      },
      {
        name: 'project', target: 'project', replace(root, _childId, _grandchildId, outside) {
          renameSync(join(root, '.saivage', 'cards', 'project'), join(outside, 'moved-project'));
          symlinkSync(join(outside, 'moved-project'), join(root, '.saivage', 'cards', 'project'));
        },
      },
      {
        name: 'committed children', target: 'child', replace(root, _childId, _grandchildId, outside) {
          const path = join(root, '.saivage', 'cards', 'project', 'children');
          renameSync(path, join(outside, 'moved-children'));
          symlinkSync(join(outside, 'moved-children'), path);
        },
      },
      {
        name: 'committed child segment', target: 'child', replace(root, childId, _grandchildId, outside) {
          const path = cardNamespace(root, childId);
          renameSync(path, join(outside, 'moved-child'));
          symlinkSync(join(outside, 'moved-child'), path);
        },
      },
      {
        name: 'committed nested children', target: 'grandchild', replace(root, childId, _grandchildId, outside) {
          const path = join(cardNamespace(root, childId), 'children');
          renameSync(path, join(outside, 'moved-nested-children'));
          symlinkSync(join(outside, 'moved-nested-children'), path);
        },
      },
      {
        name: 'committed nested segment', target: 'grandchild', replace(root, _childId, grandchildId, outside) {
          const path = cardNamespace(root, grandchildId);
          renameSync(path, join(outside, 'moved-grandchild'));
          symlinkSync(join(outside, 'moved-grandchild'), path);
        },
      },
    ];

    for (const testCase of cases) {
      const root = mkdtempSync(join(tmpdir(), `saivage-direct-card-${testCase.name.replaceAll(' ', '-')}-`)); roots.push(root); initProjectTree(root);
      const cards = new CardService(root);
      const child = cards.create({ type: 'goal', parent: 'project', title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const grandchild = cards.create({ type: 'code', parent: child.id, title: 'Grandchild', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
      const outside = mkdtempSync(join(tmpdir(), 'saivage-direct-card-outside-')); roots.push(outside);
      testCase.replace(root, child.id, grandchild.id, outside);
      const reads: string[] = [];
      const target = testCase.target === 'project' ? 'project' : testCase.target === 'child' ? child.id : grandchild.id;
      expect(() => readCard(root, target, { onRead: (stream) => reads.push(stream) })).toThrow(/real directory/);
      expect(reads.some((stream) => stream.startsWith(outside))).toBe(false);
    }
  });

  it('reaches root and leaf cards and lists empty children without a physical children directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    expect(existsSync(join(cardNamespace(root, 'project'), 'children'))).toBe(false);
    expect(readCard(root, 'project')?.id).toBe('project');
    expect(readCanonicalCardHierarchy(root, 'project')).toMatchObject({ kind: 'found', value: { activeChildren: [] } });

    const cards = new CardService(root);
    const leaf = cards.create({ type: 'code', parent: 'project', title: 'Leaf', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    expect(existsSync(join(cardNamespace(root, leaf.id), 'children'))).toBe(false);
    expect(readCard(root, leaf.id)?.id).toBe(leaf.id);
    expect(readCanonicalCardHierarchy(root, leaf.id)).toMatchObject({ kind: 'found', value: { activeChildren: [] } });
  });

  it('exposes reached descriptor snapshots through CardService for the canonical Files collaborator', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });

    const detail = cards.getCanonicalCard(child.id);
    expect(detail.kind).toBe('found');
    if (detail.kind !== 'found') throw new Error('Expected canonical child projection.');
    expect(detail.value.card.id).toBe(child.id);
    expect(detail.value.snapshot.bytes).toEqual(readFileSync(cardStreamFile(root, child.id)));
    expect(detail.value.snapshot.size).toBe(detail.value.snapshot.bytes.byteLength);

    const hierarchy = cards.getCanonicalCardChildren('project');
    expect(hierarchy.kind).toBe('found');
    if (hierarchy.kind !== 'found') throw new Error('Expected canonical project hierarchy.');
    expect(hierarchy.value.parent.card.id).toBe('project');
    expect(hierarchy.value.activeChildren.map(({ card }) => card.id)).toEqual([child.id]);
    expect(hierarchy.value.activeChildren[0]!.snapshot.bytes).toEqual(readFileSync(cardStreamFile(root, child.id)));
  });

  it('uses the proved real project root for fixed-slot metadata and content', () => {
    const physicalRoot = mkdtempSync(join(tmpdir(), 'saivage-direct-card-real-root-')); roots.push(physicalRoot); initProjectTree(physicalRoot);
    const linkParent = mkdtempSync(join(tmpdir(), 'saivage-direct-card-root-link-')); roots.push(linkParent);
    const linkedRoot = join(linkParent, 'project-link');
    symlinkSync(physicalRoot, linkedRoot, 'dir');
    const cards = new CardService(linkedRoot);

    expect(cards.getCanonicalCardFilesMetadata('project')).toMatchObject({
      kind: 'found',
      value: { files: [{ slot: 'card' }, { slot: 'brief' }] },
    });
    const content = cards.getCanonicalCardFileContent('project', 'brief', 1_048_576);
    expect(content.kind).toBe('found');
    if (content.kind !== 'found') throw new Error('Expected canonical brief content.');
    expect(content.value.snapshot.bytes.byteLength).toBeGreaterThan(0);
  });

  it('keeps every card-domain read opaque after target tombstone and stops before descendants', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cards.deleteSubtrees([parent.id], { actor: 'analyst', surface: 'runtime', reason: 'test deletion' }, () => true);

    expect(readCard(root, parent.id)).toBeNull();
    expect(cards.listCardHistory(parent.id)).toEqual({ kind: 'card-not-found' });
    expect(cards.getCardHistoryEntry(parent.id, 1)).toEqual({ kind: 'card-not-found' });
    expect(cards.diffCardHistory(parent.id, { fromSeq: 1, toSeq: 2 })).toEqual({ kind: 'card-not-found' });
    expect(() => cards.readRecord(parent.id, 'brief.md')).toThrow(AuthoredRecordNotFoundError);

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
    const parent = cards.create({ type: 'goal', parent: 'project', title: 'Parent', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const child = cards.create({ type: 'code', parent: parent.id, title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    writeFileSync(cardRecordStreamFile(root, parent.id, 'brief'), '{complete-malformed}\n');
    expect(readCard(root, child.id)?.id).toBe(child.id);
  });

  it('does not couple a card-only target read to its brief', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-direct-card-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    rmSync(cardRecordStreamFile(root, child.id, 'brief'));
    expect(readCard(root, child.id)?.id).toBe(child.id);
  });
});

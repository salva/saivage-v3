import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../helpers/canonical-project.js';
import { appendConversationBatch, readConversation } from '../../src/persistence/conversation-file.js';
import { cardRecordStreamFile, cardStreamFile } from '../../src/persistence/layout.js';
import { testRecordDefinition } from '../helpers/record-definitions.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { parseConversationSessionId, type ConversationSessionId } from '../../src/schemas/index.js';
import { CanonicalCardFilesReadModel, type CanonicalCardFilesReader } from '../../src/application/read-models/canonical-card-files-read-model.js';
import { toCardView } from '../../src/application/read-models/card-view.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'e2e' };
function input(parent: string, type: 'goal' | 'code' = 'code', depends_on: string[] = []) { return { type, parent, title: type, bootstrap_content: `${type} brief`, priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on }; }
function row(session_id: ConversationSessionId, id: string) { return { id, session_id, role: 'user' as const, kind: 'text' as const, content: id, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' } } as const, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' }; }

describe('reset-only hierarchical card storage', () => {
  it('survives restart with exact streams, records, conversations, reorder, and safe deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-hierarchy-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const goal = cards.create(input('project', 'goal'));
    const dependency = cards.create(input(goal.id));
    const dependent = cards.create(input(goal.id, 'code', [dependency.id]));
    const retainedTombstone = cards.create(input(goal.id));
    const survivor = cards.create(input('project', 'code', [dependency.id]));
    expect(readFileSync(cardStreamFile(root, goal.id), 'utf8')).toContain('"kind":"card-version"');
    expect(readFileSync(cardRecordStreamFile(root, dependency.id, testRecordDefinition('brief.md')), 'utf8')).toContain('"kind":"authored-record-version"');
    cards.openRecord(dependency.id, 'status.md'); const editedStatus = cards.editRecord(dependency.id, 'status.md', 'status'); cards.closeRecord(dependency.id, 'status.md', 'executor');
    const dependencySession = parseConversationSessionId(`agent:executor:${dependency.id}`);
    appendConversationBatch({ projectRoot: root }, [row(dependencySession, 'message')]);
    const dependencyStreamBefore = readFileSync(cardStreamFile(root, dependency.id), 'utf8');
    const dependentStreamBefore = readFileSync(cardStreamFile(root, dependent.id), 'utf8');
    const goalVersionBefore = cards.read(goal.id)!.version_seq;
    expect(cards.reorderChildren(goal.id, [dependency.id, retainedTombstone.id, dependent.id])).toEqual({ ok: true, changed: 2 });
    cards.deleteSubtrees([retainedTombstone.id], () => true, 'analyst');
    const parentBeforeIdentity = readFileSync(cardStreamFile(root, goal.id));
    expect(cards.reorderChildren(goal.id, [dependency.id, dependent.id])).toEqual({ ok: true, changed: 0 });
    expect(readFileSync(cardStreamFile(root, goal.id))).toEqual(parentBeforeIdentity);
    expect(cards.reorderChildren(goal.id, [dependent.id, dependency.id])).toEqual({ ok: true, changed: 2 });
    expect(readFileSync(cardStreamFile(root, dependency.id), 'utf8')).toBe(dependencyStreamBefore);
    expect(readFileSync(cardStreamFile(root, dependent.id), 'utf8')).toBe(dependentStreamBefore);
    const reordered = new CardService(root);
    expect(reordered.read(goal.id)).toMatchObject({
      version_seq: goalVersionBefore + 2,
      child_membership: [dependency.id, dependent.id, retainedTombstone.id],
      active_child_order: [dependent.id, dependency.id, retainedTombstone.id],
    });
    expect(reordered.read(dependency.id)?.version_seq).toBe(dependency.version_seq);
    expect(reordered.read(dependent.id)?.version_seq).toBe(dependent.version_seq);
    expect(reordered.listChildren(goal.id)).toEqual([dependent.id, dependency.id]);
    expect(toCardView(reordered, reordered.read(dependent.id)!).logical_path).toBe('1.1');
    expect(toCardView(reordered, reordered.read(dependency.id)!).logical_path).toBe('1.2');
    const files = new CanonicalCardFilesReadModel(() => reordered satisfies CanonicalCardFilesReader);
    const childrenPath = `.saivage/cards/project/children/${goal.id.split('-').at(-1)!}/children`;
    const filesResult = files.list(childrenPath);
    if ('statusCode' in filesResult) throw new Error('Expected Files child directory.');
    expect(filesResult.body.files.map(({ name }) => name)).toEqual([dependent.id.split('-').at(-1), dependency.id.split('-').at(-1)]);
    const parentRows = readFileSync(cardStreamFile(root, goal.id), 'utf8').trimEnd().split('\n').flatMap((line) => (JSON.parse(line) as { rows: Array<{ format_version: number; card: { child_membership: string[]; active_child_order: string[] }; change: { kind: string; changed_fields: string[] } | null }> }).rows);
    expect(parentRows.every((artifact) => artifact.format_version === 3)).toBe(true);
    const linkRows = parentRows.filter((artifact) => artifact.change?.kind === 'child_link');
    expect(linkRows.map((artifact) => artifact.card.child_membership)).toEqual([
      [dependency.id], [dependency.id, dependent.id], [dependency.id, dependent.id, retainedTombstone.id],
    ]);
    expect(linkRows.every((artifact) => artifact.change?.changed_fields.join(',') === 'child_membership,active_child_order')).toBe(true);
    const reorderRows = parentRows.filter((artifact) => artifact.change?.kind === 'reorder');
    expect(reorderRows.map((artifact) => artifact.card.child_membership)).toEqual([
      [dependency.id, dependent.id, retainedTombstone.id], [dependency.id, dependent.id, retainedTombstone.id],
    ]);
    expect(reorderRows.map((artifact) => artifact.card.active_child_order)).toEqual([
      [dependency.id, retainedTombstone.id, dependent.id], [dependent.id, dependency.id, retainedTombstone.id],
    ]);
    expect(reorderRows.every((artifact) => artifact.change?.changed_fields.join(',') === 'active_child_order')).toBe(true);
    expect(() => cards.deleteSubtrees([goal.id], () => true)).toThrow(new RegExp(survivor.id));
    const deleted = cards.deleteSubtrees([dependency.id, dependent.id, survivor.id], () => true);
    expect(deleted.deleted.indexOf(dependent.id)).toBeLessThan(deleted.deleted.indexOf(dependency.id));
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'children', 'z'));

    const restarted = new CardService(root);
    expect(restarted.read(goal.id)).not.toBeNull();
    expect(restarted.read(dependency.id)).toBeNull();
    const historical=restarted.readRecordVersion(goal.id,'brief.md',1);expect(historical.kind).toBe('found');if(historical.kind==='found')expect(historical.value.projection.versionUrl).toContain('&v=1');
    expect(restarted.read('card-z')).toBeNull();
    expect(restarted.list().map(({ id }) => id)).not.toContain('card-z');
    expect(readConversation(root, dependencySession).physicalRows.map(({ id }) => id)).toEqual(['message']);
    appendConversationBatch({ projectRoot: root }, [row(dependencySession, 'after-tombstone')]);
    expect(readConversation(root, dependencySession).physicalRows.map(({ id }) => id)).toEqual(['message', 'after-tombstone']);
    expect(restarted.getParent(restarted.create(input(goal.id)).id)).toBe(goal.id);
  });
});

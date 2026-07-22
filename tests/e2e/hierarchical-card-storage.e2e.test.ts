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

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'e2e' };
function input(parent: string, type: 'goal' | 'code' = 'code', depends_on: string[] = []) { return { type, parent, title: type, bootstrap_content: `${type} brief`, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on, related: [] }; }
function row(session_id: ConversationSessionId, id: string) { return { id, session_id, role: 'user' as const, kind: 'text' as const, content: id, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' }; }

describe('reset-only hierarchical card storage', () => {
  it('survives restart with exact streams, records, conversations, reorder, and safe deletion', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-hierarchy-e2e-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const goal = cards.create(input('project', 'goal'));
    const dependency = cards.create(input(goal.id));
    const dependent = cards.create(input(goal.id, 'code', [dependency.id]));
    const survivor = cards.create(input('project', 'code', [dependency.id]));
    expect(readFileSync(cardStreamFile(root, goal.id), 'utf8')).toContain('card-version');
    expect(readFileSync(cardRecordStreamFile(root, dependency.id, testRecordDefinition('brief.md')), 'utf8')).toContain('record-revision');
    const status = cards.openRecord(dependency.id, 'status.md'); cards.editRecord(dependency.id, 'status.md', status.version, 'status'); cards.closeRecord(dependency.id, 'status.md', status.version, 'executor', dependency.version_seq);
    const dependencySession = parseConversationSessionId(`agent:executor:${dependency.id}`);
    appendConversationBatch({ projectRoot: root }, [row(dependencySession, 'message')]);
    const dependencyStreamBefore = readFileSync(cardStreamFile(root, dependency.id), 'utf8');
    const dependentStreamBefore = readFileSync(cardStreamFile(root, dependent.id), 'utf8');
    const goalVersionBefore = cards.read(goal.id)!.version_seq;
    expect(cards.reorderChildren(goal.id, [dependent.id, dependency.id])).toEqual({ ok: true, changed: 2 });
    expect(readFileSync(cardStreamFile(root, dependency.id), 'utf8')).toBe(dependencyStreamBefore);
    expect(readFileSync(cardStreamFile(root, dependent.id), 'utf8')).toBe(dependentStreamBefore);
    const reordered = new CardService(root);
    expect(reordered.read(goal.id)).toMatchObject({ version_seq: goalVersionBefore + 1, children: [dependent.id, dependency.id] });
    expect(reordered.read(dependency.id)?.version_seq).toBe(dependency.version_seq);
    expect(reordered.read(dependent.id)?.version_seq).toBe(dependent.version_seq);
    expect(reordered.listChildren(goal.id)).toEqual([dependent.id, dependency.id]);
    expect(() => cards.deleteSubtrees([goal.id], () => true)).toThrow(new RegExp(survivor.id));
    const deleted = cards.deleteSubtrees([dependency.id, dependent.id, survivor.id], () => true);
    expect(deleted.deleted.indexOf(dependent.id)).toBeLessThan(deleted.deleted.indexOf(dependency.id));
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'children', 'z'));

    const restarted = new CardService(root);
    expect(restarted.read(goal.id)).not.toBeNull();
    expect(restarted.read(dependency.id)).toBeNull();
    expect(restarted.readRecord(goal.id, 'brief.md', 1).recordUrl).toContain('&v=1');
    expect(restarted.read('card-z')).toBeNull();
    expect(restarted.list().map(({ id }) => id)).not.toContain('card-z');
    expect(readConversation(root, dependencySession).physicalRows.map(({ id }) => id)).toEqual(['message']);
    appendConversationBatch({ projectRoot: root }, [row(dependencySession, 'after-tombstone')]);
    expect(readConversation(root, dependencySession).physicalRows.map(({ id }) => id)).toEqual(['message', 'after-tombstone']);
    expect(restarted.getParent(restarted.create(input(goal.id)).id)).toBe(goal.id);
  });
});

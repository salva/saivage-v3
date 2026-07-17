import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, ftruncateSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { appendConversationBatch, listConversationSessionIds, readConversation } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { appendAnalystIngressBatch } from '../../src/runtime/actors/conversation-session.js';
import { parseConversationSessionId, type ConversationSessionId } from '../../src/schemas/index.js';

const roots: string[] = [];
const io: GrowingFileIo = { read: readFileSync, open: openSync, write: writeSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function message(session_id: ConversationSessionId, id: string) { return { id, session_id, role: 'user' as const, kind: 'text' as const, content: id, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' }; }

describe('domain-derived conversation inventory', () => {
  it('lists exact active role/global candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root, undefined, undefined, () => 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    appendConversationBatch(root, [message('planner:project', 'planner')]);
    appendConversationBatch(root, [message(parseConversationSessionId(`executor:${child.id}`), 'executor')]);
    appendAnalystIngressBatch({ projectRoot: root }, '11111111-1111-4111-8111-111111111111', 'workspace', 'global');
    expect(listConversationSessionIds(root)).toEqual(['analyst:global', `executor:${child.id}`, 'planner:project']);
    for (const invalid of ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other']) expect(() => parseConversationSessionId(invalid)).toThrow();
  });

  it('never inspects malformed noncandidate files or unlinked card conversations', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    writeFileSync(join(root, '.saivage', 'agents', 'conversations', 'unrelated.jsonl'), '{malformed}\n');
    const orphan = join(root, '.saivage', 'cards', 'project', 'children', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'conversations');
    mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'executor.jsonl'), '{malformed}\n');
    expect(listConversationSessionIds(root)).toEqual([]);
    expect(() => readConversation(root, 'executor:card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow(/malformed/);
  });

  it('emits no effects for a complete outcome-unknown conversation append', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    appendConversationBatch(root, [message('planner:project', 'first')]);
    const effects: string[] = [];
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe({ conversationChanged: () => { effects.push('conversation'); }, agentsChanged: () => { effects.push('agents'); }, cardStateChanged() {}, runtimeChanged() {} });
    expect(() => appendConversationBatch(root, [message('planner:project', 'second')], changes, undefined, { ...io, fsync(fd) { fsyncSync(fd); throw new Error('conversation fsync'); } })).toThrow('conversation fsync');
    expect(effects).toEqual([]);
    expect(readConversation(root, 'planner:project').physicalRows.map(({ id }) => id)).toEqual(['first', 'second']);
  });
});

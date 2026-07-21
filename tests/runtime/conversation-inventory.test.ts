import { afterEach, describe, expect, it } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { appendConversationBatch, readConversation, readConversationInventory } from '../../src/persistence/conversation-file.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { appendAnalystIngressBatch } from '../../src/runtime/actors/conversation-session.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { parseConversationSessionId, type ConversationSessionId } from '../../src/schemas/index.js';
import { cardConversationFile } from '../../src/persistence/layout.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function message(session_id: ConversationSessionId, id: string) { return { id, session_id, role: 'user' as const, kind: 'text' as const, content: id, round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' }; }

describe('domain-derived conversation inventory', () => {
  it('lists exact active role/global candidates', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    appendConversationBatch({ projectRoot: root }, [message('planner:project', 'planner')]);
    appendConversationBatch({ projectRoot: root }, [message(parseConversationSessionId(`executor:${child.id}`), 'executor')]);
    appendAnalystIngressBatch({ projectRoot: root }, '11111111-1111-4111-8111-111111111111', 'workspace', 'global');
    const inventory = readConversationInventory(root);
    expect(inventory.map(({ sessionId }) => sessionId)).toEqual(['analyst:global', `executor:${child.id}`, 'planner:project']);
    expect(Object.isFrozen(inventory)).toBe(true);
    expect(inventory.every(Object.isFrozen)).toBe(true);
    for (const invalid of ['global', 'analyst:test', 'analyst:telegram-42', 'analyst:other']) expect(() => parseConversationSessionId(invalid)).toThrow();
  });

  it('never inspects malformed noncandidate files or unlinked card conversations', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    writeFileSync(join(root, '.saivage', 'agents', 'conversations', 'unrelated.jsonl'), '{malformed}\n');
    const orphan = join(root, '.saivage', 'cards', 'project', 'children', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'conversations');
    mkdirSync(orphan, { recursive: true }); writeFileSync(join(orphan, 'executor.jsonl'), '{malformed}\n');
    expect(readConversationInventory(root)).toEqual([]);
    expect(() => readConversation(root, 'executor:card-bbbbbbbbbbbbbbbbbbbbbbbbbbbb')).toThrow(/malformed/);
  });

  it('retains planner inventory and never discovers malformed executor history for a goal', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    const cards = new CardService(root);
    const goal = cards.create({ type: 'goal', parent: 'project', title: 'goal', brief: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const plannerSession = parseConversationSessionId(`planner:${goal.id}`);
    appendConversationBatch({ projectRoot: root }, [message(plannerSession, 'planner-goal')]);
    writeFileSync(cardConversationFile(root, goal.id, 'executor'), '{complete-malformed}\n');

    const inventory = readConversationInventory(root);
    expect(inventory.map(({ sessionId }) => sessionId)).toEqual([plannerSession]);
    expect(inventory[0]!.conversation.physicalRows.map(({ id }) => id)).toEqual(['planner-goal']);
    expect(readConversation(root, plannerSession).physicalRows.map(({ id }) => id)).toEqual(['planner-goal']);
  });

  it('fails strictly on a complete malformed eligible candidate', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    writeFileSync(cardConversationFile(root, 'project', 'reviewer'), '{"version":1,"type":"rows","rows":[{"invalid":true}]}\n');
    expect(() => readConversationInventory(root)).toThrow(/Growing file '.*reviewer\.jsonl' envelope 1 is malformed/);
  });

  it('emits no effects for a complete outcome-unknown conversation append', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-inventory-')); roots.push(root); initProjectTree(root);
    appendConversationBatch({ projectRoot: root }, [message('planner:project', 'first')]);
    const effects: string[] = [];
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe({ conversationChanged: () => { effects.push('conversation'); }, agentsChanged: () => { effects.push('agents'); }, cardProjectionChanged() {}, runtimeChanged() {} });
    const failure = new Error('conversation fsync');
    const operations: string[] = [];
    const failingIo: GrowingFileIo = {
      open(path, flags) { operations.push(`open:${path}`); return openSync(path, flags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => { operations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); throw failure; },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    let thrown: unknown;
    try { appendConversationBatch({ projectRoot: root, changes, observeEntry: () => { effects.push('observation'); } }, [message('planner:project', 'second')], { io: failingIo }); } catch (error) { thrown = error; }
    expect(thrown).toBe(failure);
    expect(operations).toEqual([`open:${conversationFile(root, 'planner:project')}`, 'stat', 'write', 'fsync', 'close']);
    expect(effects).toEqual([]);
  });
});

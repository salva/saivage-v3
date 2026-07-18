import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, ftruncateSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
const io: GrowingFileIo = { read: readFileSync, open: openSync, write: writeSync, fsync: fsyncSync, truncate: ftruncateSync, close: closeSync };
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-delete-order-')); roots.push(root); initProjectTree(root); return { root, cards: new CardService(root) }; }
function create(cards: CardService, parent = 'project', depends_on: string[] = [], type: 'code' | 'goal' = 'code') { return cards.create({ type, parent, title: 'card', brief: 'brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on, related: [] }); }
const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'test' };

describe('complete-union deletion admission and order', () => {
  it('deduplicates duplicate and overlapping roots and orders child before parent', () => {
    const { cards } = setup(); const parent = create(cards, 'project', [], 'goal'); const child = create(cards, parent.id); const sibling = create(cards);
    const result = cards.deleteSubtrees([parent.id, child.id, parent.id, sibling.id], context, () => true);
    expect(result.requested).toEqual([parent.id, child.id, sibling.id]);
    expect(result.deleted).toEqual([child.id, parent.id, sibling.id]);
    expect(result.deleted.indexOf(child.id)).toBeLessThan(result.deleted.indexOf(parent.id));
    expect(cards.list().map(({ id }) => id)).toEqual(['project']);
  });

  it('rejects unknown, root, permission denial, and surviving dependents before mutation', () => {
    const { root, cards } = setup(); const dependency = create(cards); const survivor = create(cards, 'project', [dependency.id]);
    const before = readFileSync(cardStreamFile(root, dependency.id));
    expect(() => cards.deleteSubtrees(['card-zzzzzzzzzzzzzzzzzzzzzzzzzzzz'], context, () => true)).toThrow();
    expect(() => cards.deleteSubtrees(['project'], context, () => true)).toThrow();
    expect(() => cards.deleteSubtrees([dependency.id], context, () => false)).toThrow(/denied/);
    expect(() => cards.deleteSubtrees([dependency.id], context, () => true)).toThrow(new RegExp(survivor.id));
    expect(readFileSync(cardStreamFile(root, dependency.id))).toEqual(before);
  });

  it('orders intended dependents before dependencies across requested subtrees', () => {
    const { cards } = setup(); const dependency = create(cards); const dependent = create(cards, 'project', [dependency.id]);
    const result = cards.deleteSubtrees([dependency.id, dependent.id], context, () => true);
    expect(result.deleted.indexOf(dependent.id)).toBeLessThan(result.deleted.indexOf(dependency.id));
  });

  it('rejects a combined hierarchy/dependency cycle before mutation', () => {
    const { root, cards } = setup(); const parent = create(cards, 'project', [], 'goal'); const child = create(cards, parent.id);
    cards.updateDependsOn(parent.id, [child.id], context);
    const before = readFileSync(cardStreamFile(root, child.id));
    expect(() => cards.deleteSubtrees([parent.id], context, () => true)).toThrow(/constraints conflict/);
    expect(readFileSync(cardStreamFile(root, child.id))).toEqual(before);
  });

  it('stops after the first reported append failure and emits only confirmed-prefix effects', () => {
    const { root, cards } = setup(); const left = create(cards); const right = create(cards);
    let writes = 0;
    const failSecondWrite = ((fd: number, bytes: Uint8Array, offset: number, length: number) => { writes += 1; if (writes === 2) throw new Error('injected tombstone failure'); return writeSync(fd, bytes, offset, length); }) as typeof writeSync;
    const failingIo: GrowingFileIo = { ...io, write: failSecondWrite };
    const eventBus = new EventBus(); const events: Array<{ cardId: string; kind: string }> = []; eventBus.subscribe('card_history_appended', (event) => { events.push({ cardId: event.payload.card_id, kind: event.payload.entry_kind }); });
    const changes = new ReadModelChangeBroadcaster(); const cardEffects = jest.fn(); const runtimeEffects = jest.fn(); changes.subscribe({ cardStateChanged: cardEffects, runtimeChanged: runtimeEffects, agentsChanged() {}, conversationChanged() {} });
    const deleting = new CardService(root, eventBus, changes, failingIo);
    expect(() => deleting.deleteSubtrees([left.id, right.id], context, () => true)).toThrow('injected tombstone failure');
    expect(cardEffects).toHaveBeenCalledTimes(1);
    expect(runtimeEffects).toHaveBeenCalledTimes(1);
    expect(events).toEqual([{ cardId: left.id, kind: 'delete' }]);
    expect(deleting.read(left.id)).toBeNull();
    expect(deleting.read(right.id)).not.toBeNull();
  });

  it('emits no effect for a complete outcome-unknown tombstone and attempts no later card', () => {
    const { root, cards } = setup(); const left = create(cards); const right = create(cards);
    const failingIo: GrowingFileIo = { ...io, fsync(fd) { fsyncSync(fd); throw new Error('uncertain tombstone'); } };
    const eventBus = new EventBus(); const events = jest.fn(); eventBus.subscribe('card_history_appended', (event) => { events(event); });
    const changes = new ReadModelChangeBroadcaster(); const cardEffects = jest.fn(); const runtimeEffects = jest.fn(); changes.subscribe({ cardStateChanged: cardEffects, runtimeChanged: runtimeEffects, agentsChanged() {}, conversationChanged() {} });
    const deleting = new CardService(root, eventBus, changes, failingIo);
    expect(() => deleting.deleteSubtrees([left.id, right.id], context, () => true)).toThrow('uncertain tombstone');
    expect(cardEffects).not.toHaveBeenCalled();
    expect(runtimeEffects).not.toHaveBeenCalled();
    expect(events).not.toHaveBeenCalled();
    expect(deleting.read(left.id)).toBeNull();
    expect(deleting.read(right.id)).not.toBeNull();
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardService } from '../helpers/canonical-project.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/publication-outcome.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-delete-order-')); roots.push(root); initProjectTree(root); return { root, cards: new CardService(root) }; }
function create(cards: CardService, parent = 'project', depends_on: string[] = [], type: 'code' | 'goal' = 'code') { return cards.create({ type, parent, title: 'card', bootstrap_content: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on, related: [] }); }
const context = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'test' };

describe('complete-union deletion admission and order', () => {
  it('deduplicates duplicate and overlapping roots and orders child before parent', () => {
    const { cards } = setup(); const parent = create(cards, 'project', [], 'goal'); const child = create(cards, parent.id); const sibling = create(cards);
    const result = cards.deleteSubtrees([parent.id, child.id, parent.id, sibling.id], () => true);
    expect(result.requested).toEqual([parent.id, child.id, sibling.id]);
    expect(result.deleted).toEqual([child.id, parent.id, sibling.id]);
    expect(result.deleted.indexOf(child.id)).toBeLessThan(result.deleted.indexOf(parent.id));
    expect(cards.list().map(({ id }) => id)).toEqual(['project']);
  });

  it('rejects unknown, root, permission denial, and surviving dependents before mutation', () => {
    const { root, cards } = setup(); const dependency = create(cards); const survivor = create(cards, 'project', [dependency.id]);
    const before = readFileSync(cardStreamFile(root, dependency.id));
    expect(() => cards.deleteSubtrees(['card-zzzzzzzzzzzzzzzzzzzzzzzzzzzz'], () => true)).toThrow();
    expect(() => cards.deleteSubtrees(['project'], () => true)).toThrow();
    expect(() => cards.deleteSubtrees([dependency.id], () => false)).toThrow(/denied/);
    expect(() => cards.deleteSubtrees([dependency.id], () => true)).toThrow(new RegExp(survivor.id));
    expect(readFileSync(cardStreamFile(root, dependency.id))).toEqual(before);
  });

  it('orders intended dependents before dependencies across requested subtrees', () => {
    const { cards } = setup(); const dependency = create(cards); const dependent = create(cards, 'project', [dependency.id]);
    const result = cards.deleteSubtrees([dependency.id, dependent.id], () => true);
    expect(result.deleted.indexOf(dependent.id)).toBeLessThan(result.deleted.indexOf(dependency.id));
  });

  it('stops after the first reported append failure and emits only confirmed-prefix effects', () => {
    const { root, cards } = setup(); const left = create(cards); const right = create(cards);
    const failure = new Error('injected tombstone failure');
    const operations: string[] = [];
    let writes = 0;
    const failingIo: GrowingFileIo = {
      open(path, flags) { operations.push(`open:${path}`); return openSync(path, flags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => {
        operations.push('write');
        writes += 1;
        if (writes === 2) throw failure;
        return Reflect.apply(writeSync, undefined, args);
      }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    const cardEffects = jest.fn(); const runtimeEffects = jest.fn();
    const deleting = new CardService(root, { cardProjectionChanged: cardEffects, runtimeChanged: runtimeEffects,agentMembershipChanged:jest.fn() }, failingIo);
    let thrown: unknown;
    try { deleting.deleteSubtrees([left.id, right.id], () => true); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(operations).toEqual([
      `open:${cardStreamFile(root, left.id)}`, 'stat', 'write', 'fsync', 'close',
      `open:${cardStreamFile(root, right.id)}`, 'stat', 'write',
    ]);
    expect(cardEffects).toHaveBeenCalledTimes(7);
    expect(cardEffects.mock.calls.map(([target]) => target)).toEqual([
      { resource: 'cards', scope: 'detail', card_id: left.id },
      { resource: 'cards', scope: 'history', card_id: left.id },
      { resource: 'cards', scope: 'diff', card_id: left.id },
      { resource: 'cards', scope: 'children', card_id: left.id },
      { resource: 'cards', scope: 'children', card_id: 'project' },
      { resource: 'cards', scope: 'record', card_id: left.id, record_name: 'brief.md' },
      { resource: 'cards', scope: 'record', card_id: left.id, record_name: 'status.md' },
    ]);
    expect(runtimeEffects).toHaveBeenCalledTimes(1);
  });

  it('emits no effect for a complete outcome-unknown tombstone and attempts no later card', () => {
    const { root, cards } = setup(); const left = create(cards); const right = create(cards);
    const failure = new Error('uncertain tombstone');
    const operations: string[] = [];
    const failingIo: GrowingFileIo = {
      open(path, flags) { operations.push(`open:${path}`); return openSync(path, flags); },
      stat(fd) { operations.push('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => { operations.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { operations.push('fsync'); fsyncSync(fd); throw failure; },
      close(fd) { operations.push('close'); closeSync(fd); },
    };
    const cardEffects = jest.fn(); const runtimeEffects = jest.fn();
    const deleting = new CardService(root, { cardProjectionChanged: cardEffects, runtimeChanged: runtimeEffects,agentMembershipChanged:jest.fn() }, failingIo);
    let thrown: unknown;
    try { deleting.deleteSubtrees([left.id, right.id], () => true); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError);
    expect(operations).toEqual([`open:${cardStreamFile(root, left.id)}`, 'stat', 'write', 'fsync']);
    expect(cardEffects).not.toHaveBeenCalled();
    expect(runtimeEffects).not.toHaveBeenCalled();
  });

  it('fails fast without effects when a required tombstone stream is missing at append open', () => {
    const { root, cards } = setup(); const child = create(cards);
    const missingIo: GrowingFileIo = {
      open() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };
    const effects = jest.fn();
    const deleting = new CardService(root, { cardProjectionChanged: effects, runtimeChanged: effects,agentMembershipChanged:effects }, missingIo);
    expect(() => deleting.deleteSubtrees([child.id], () => true)).toThrow(/disappeared before tombstone append/);
    expect(effects).not.toHaveBeenCalled();
  });
});

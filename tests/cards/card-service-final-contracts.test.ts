import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, ftruncateSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import type { CardPatch, NewCardInput } from '../../src/cards/lifecycle.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { EventBus } from '../../src/events/index.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';

const FIRST_SEGMENT = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_SEGMENT = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const THIRD_SEGMENT = 'cccccccccccccccccccccccccccc';
const FIRST = `card-${FIRST_SEGMENT}`;
const SECOND = `card-${SECOND_SEGMENT}`;
const THIRD = `card-${THIRD_SEGMENT}`;

function input(parent = 'project'): NewCardInput {
  return {
    type: 'code', parent, title: 'Implement final contract', brief: 'Use direct card I/O.',
    status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
  };
}

type PublicationSnapshot = {
  kind: 'card' | 'runtime';
  card: ReturnType<CardService['read']>;
  listedIds: string[];
  byType: Record<string, string[]>;
};

function observableCardService(root: string): { cards: CardService; publications: PublicationSnapshot[]; historyEvents: string[] } {
  const changes = new ReadModelChangeBroadcaster();
  const publications: PublicationSnapshot[] = [];
  const historyEvents: string[] = [];
  const eventBus = new EventBus();
  eventBus.subscribe('card_history_appended', ({ payload }) => { historyEvents.push(payload.card_id); });
  let cards!: CardService;
  const snapshot = (kind: PublicationSnapshot['kind']): PublicationSnapshot => {
    const listed = cards.list();
    const byType = listed.reduce<Record<string, string[]>>((index, card) => {
      (index[card.type] ??= []).push(card.id);
      return index;
    }, {});
    return {
      kind,
      card: cards.read(FIRST),
      listedIds: listed.map(({ id }) => id),
      byType,
    };
  };
  changes.subscribe({
    cardStateChanged: () => publications.push(snapshot('card')),
    runtimeChanged: () => publications.push(snapshot('runtime')),
    agentsChanged: () => undefined,
    conversationChanged: () => undefined,
  });
  const segments = [FIRST_SEGMENT, SECOND_SEGMENT, THIRD_SEGMENT];
  cards = new CardService(root, eventBus, changes, () => segments.shift()!);
  return { cards, publications, historyEvents };
}

describe('CardService final reset-only contracts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-card-service-')); initProjectTree(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uses one opaque identity per creation attempt and never derives identity from existing namespaces', () => {
    const identity = jest.fn<() => string>().mockReturnValueOnce(FIRST_SEGMENT).mockReturnValueOnce(SECOND_SEGMENT);
    const cards = new CardService(root, undefined, undefined, identity);
    expect(cards.create(input()).id).toBe(FIRST);
    expect(cards.create(input()).id).toBe(SECOND);
    expect(identity).toHaveBeenCalledTimes(2);
    expect(cards.listChildren('project')).toEqual([FIRST, SECOND]);
  });

  it('lists and reorders only the exact parent and its committed child references', () => {
    const segments = [FIRST_SEGMENT, SECOND_SEGMENT, THIRD_SEGMENT];
    const cards = new CardService(root, undefined, undefined, () => segments.shift()!);
    const parent = cards.create({ ...input(), type: 'goal' });
    const child = cards.create(input(parent.id));
    const unrelated = cards.create(input());
    writeFileSync(cardStreamFile(root, unrelated.id), '{complete-malformed}\n');

    expect(cards.listChildren(parent.id)).toEqual([child.id]);
    expect(cards.reorderChildren(parent.id, [child.id], { actor: 'analyst', surface: 'runtime', reason: 'exact reorder' })).toEqual({ ok: true, changed: 0 });
    expect(() => cards.list()).toThrow();
  });

  it('admits a fresh parent and confirms the linked child before history/card/runtime effects', () => {
    const parent = new CardService(root, undefined, undefined, () => FIRST_SEGMENT).create({ ...input(), type: 'goal' });
    const childId = `${parent.id}-${SECOND_SEGMENT}`;
    const order: string[] = [];
    const eventBus = new EventBus();
    const assertLinkedVisibility = () => {
      const observer = new CardService(root);
      expect(observer.read(parent.id)?.children).toEqual([childId]);
      expect(observer.listChildren(parent.id)).toEqual([childId]);
      expect(observer.list().map(({ id }) => id)).toEqual(['project', parent.id, childId]);
      expect(observer.read(childId)?.id).toBe(childId);
    };
    eventBus.subscribe('card_history_appended', (event) => {
      order.push('history');
      expect(event.payload).toMatchObject({ entry_kind: 'child_link', card_id: parent.id });
      assertLinkedVisibility();
    });
    const changes = new ReadModelChangeBroadcaster();
    changes.subscribe({
      cardStateChanged: () => { order.push('card'); assertLinkedVisibility(); },
      runtimeChanged: () => { order.push('runtime'); assertLinkedVisibility(); },
      agentsChanged() {},
      conversationChanged() {},
    });
    const writeParentLink = ((...args: unknown[]) => {
      order.push('parent-link-write');
      return Reflect.apply(writeSync, undefined, args);
    }) as typeof writeSync;
    const io: GrowingFileIo = {
      read: readFileSync,
      open(path, flags) {
        order.push('parent-link-open');
        const observer = new CardService(root);
        expect(observer.read(parent.id)?.children).toEqual([]);
        expect(observer.listChildren(parent.id)).toEqual([]);
        expect(observer.list().map(({ id }) => id)).toEqual(['project', parent.id]);
        expect(observer.read(childId)).toBeNull();
        return openSync(path, flags);
      },
      write: writeParentLink,
      fsync(fd) { order.push('parent-link-fsync'); fsyncSync(fd); },
      truncate: ftruncateSync,
      close(fd) { order.push('parent-link-close'); closeSync(fd); },
    };
    const cards = new CardService(root, eventBus, changes, () => SECOND_SEGMENT, io);

    const child = cards.create(input(parent.id));

    expect(child.id).toBe(childId);
    // Reaching the append means publishInitialCard completed its initial-stream proof,
    // CardService freshly admitted the still-unlinked parent, and its second proof returned.
    expect(order).toEqual(['parent-link-open', 'parent-link-write', 'parent-link-fsync', 'parent-link-close', 'history', 'card', 'runtime']);
  });

  it('projects a cloned target and dependency statuses in declared order', () => {
    const identity = jest.fn<() => string>().mockReturnValueOnce(FIRST_SEGMENT).mockReturnValueOnce(SECOND_SEGMENT).mockReturnValueOnce(THIRD_SEGMENT);
    const cards = new CardService(root, undefined, undefined, identity);
    cards.create(input());
    cards.create(input());
    cards.setStatus(FIRST, 'running');
    cards.commitTerminalLifecyclePatch(FIRST, {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'complete' }, error: null, completed_at: '2026-07-17T00:00:00.000Z' },
    });
    cards.create({ ...input(), title: 'Dependent card', depends_on: [SECOND, FIRST] });

    const projection = cards.readActivationAdmission(THIRD);
    expect(projection).toMatchObject({
      child: { id: THIRD, depends_on: [SECOND, FIRST] },
      dependencies: [{ id: SECOND, status: 'backlog' }, { id: FIRST, status: 'done' }],
    });

    projection!.child.title = 'mutated projection';
    projection!.dependencies[0]!.status = 'cancelled';
    expect(cards.readActivationAdmission(THIRD)).toMatchObject({
      child: { title: 'Dependent card' },
      dependencies: [{ id: SECOND, status: 'backlog' }, { id: FIRST, status: 'done' }],
    });
  });

  it('returns null only when the requested target is absent', () => {
    const cards = new CardService(root);
    expect(cards.readActivationAdmission(FIRST)).toBeNull();
    expect(cards.readActivationAdmission('project')).toMatchObject({ child: { id: 'project' }, dependencies: [] });
  });

  it('rejects missing dependencies before identity generation and mutation', () => {
    const identity = jest.fn<() => string>(() => FIRST_SEGMENT);
    const cards = new CardService(root, undefined, undefined, identity);
    expect(() => cards.create({ ...input(), depends_on: [SECOND] })).toThrow(`Dependency card '${SECOND}' does not exist.`);
    expect(identity).not.toHaveBeenCalled();
  });

  it('draws identity before freshly admitting sibling position immediately before claim', () => {
    const parent = new CardService(root, undefined, undefined, () => FIRST_SEGMENT).create({ ...input(), type: 'goal' });
    const identity = jest.fn(() => {
      const concurrent = new CardService(root, undefined, undefined, () => SECOND_SEGMENT);
      const sibling = concurrent.create(input(parent.id));
      expect(sibling.position).toBe(0);
      return THIRD_SEGMENT;
    });
    const created = new CardService(root, undefined, undefined, identity).create(input(parent.id));
    expect(identity).toHaveBeenCalledTimes(1);
    expect(created.position).toBe(1);
    expect(new CardService(root).listChildren(parent.id)).toEqual([`${parent.id}-${SECOND_SEGMENT}`, `${parent.id}-${THIRD_SEGMENT}`]);
  });

  it('propagates malformed canonical card artifacts', () => {
    writeFileSync(join(root, '.saivage', 'cards', 'project', 'card.jsonl'), '{malformed}\n');
    expect(() => new CardService(root).readActivationAdmission('project')).toThrow();
  });

  it.each(['backlog', 'running', 'changed', 'blocked'] as const)('preserves notifications while %s remains unresolved', (status) => {
    const cards = new CardService(root, undefined, undefined, () => FIRST_SEGMENT);
    cards.create(input());
    if (status !== 'backlog') {
      cards.setStatus(FIRST, 'running');
      if (status === 'changed') cards.setStatus(FIRST, 'changed');
      if (status === 'blocked') cards.commitTerminalLifecyclePatch(FIRST, { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'wait', resume_reason: 'wait' }, error: 'wait', completed_at: null } });
    }
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'new facts', created_at: '2026-07-15T00:00:00.000Z' });
    expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n1']);
    if (status === 'blocked') {
      cards.setStatus(FIRST, 'running');
      expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n1']);
    }
  });

  it.each(['done', 'failed', 'cancelled'] as const)('clears notifications and rejects enqueue after %s', (status) => {
    const cards = new CardService(root, undefined, undefined, () => FIRST_SEGMENT);
    cards.create(input());
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'new facts', created_at: '2026-07-15T00:00:00.000Z' });
    cards.setStatus(FIRST, 'running');
    if (status === 'cancelled') cards.setStatus(FIRST, status);
    else cards.commitTerminalLifecyclePatch(FIRST, { status, lifecycle: status === 'done'
      ? { status, result: { kind: 'done', summary: 'ok' }, error: null, completed_at: '2026-07-15T00:00:01.000Z' }
      : { status, result: { kind: 'failed', summary: 'bad' }, error: 'bad', completed_at: '2026-07-15T00:00:01.000Z' } });
    expect(cards.read(FIRST)?.pending_notifications).toEqual([]);
    expect(() => cards.enqueueNotification(FIRST, { id: 'n2', content: 'late', created_at: '2026-07-15T00:00:02.000Z' })).toThrow(/terminal card/);
  });

  it('removes exactly selected notification ids and preserves later entries', () => {
    const cards = new CardService(root, undefined, undefined, () => FIRST_SEGMENT);
    cards.create(input());
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'one', created_at: '2026-07-15T00:00:00.000Z' });
    cards.enqueueNotification(FIRST, { id: 'n2', content: 'two', created_at: '2026-07-15T00:00:01.000Z' });
    cards.removeNotifications(FIRST, ['n1']);
    expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n2']);
  });

  it('publishes card then runtime synchronously after create and delete are readable', () => {
    const { cards, publications } = observableCardService(root);

    cards.create(input());
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card, listedIds }) => card?.id === FIRST && listedIds.includes(FIRST))).toBe(true);
    expect(publications.every(({ byType }) => byType.code?.includes(FIRST))).toBe(true);

    publications.length = 0;
    cards.deleteSubtrees([FIRST], { actor: 'runtime', surface: 'runtime' }, () => true);
    expect(publications).toEqual([
      { kind: 'card', card: null, listedIds: ['project'], byType: { project: ['project'] } },
      { kind: 'runtime', card: null, listedIds: ['project'], byType: { project: ['project'] } },
    ]);
  });

  it('publishes runtime exactly once for actual status patches and not ordinary edits', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    cards.setStatus(FIRST, 'running');
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card }) => card?.status === 'running')).toBe(true);

    cards.setStatus(FIRST, 'backlog');
    publications.length = 0;
    cards.update(FIRST, { title: 'Edited without changing runtime indexes' });
    expect(publications.map(({ kind }) => kind)).toEqual(['card']);
    expect(publications[0]?.card).toMatchObject({ type: 'code', title: 'Edited without changing runtime indexes' });

    cards.setStatus(FIRST, 'running');
    publications.length = 0;
    cards.commitTerminalLifecyclePatch(FIRST, {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'complete' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' },
    });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card }) => card?.status === 'done' && card.type === 'code')).toBe(true);
  });

  it('rejects a forged type patch before append or success effects and preserves the readable stream', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    cards.create(input());
    const initialHistoryEvents = historyEvents.length;
    publications.length = 0;

    expect(() => cards.update(FIRST, { type: 'test' } as unknown as CardPatch))
      .toThrow("mutates immutable field 'type'");

    expect(publications).toEqual([]);
    expect(historyEvents).toHaveLength(initialHistoryEvents);
    expect(cards.read(FIRST)).toMatchObject({ id: FIRST, type: 'code', version_seq: 1 });
    expect(cards.listCardHistory(FIRST)).toEqual([]);
  });

  it('keeps no-op patches silent and real non-index updates card-only', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    cards.setStatus(FIRST, 'backlog');
    cards.update(FIRST, {});
    expect(publications).toEqual([]);

    cards.update(FIRST, { status: 'backlog', title: 'Updated title' });
    expect(publications.map(({ kind }) => kind)).toEqual(['card']);
    expect(publications[0]?.card?.title).toBe('Updated title');
  });

  it('publishes no post-success hints when create or delete fails', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    expect(() => cards.create({ ...input(), depends_on: ['card-zzzzzzzzzzzzzzzzzzzzzzzzzzzz'] })).toThrow();
    expect(publications).toEqual([]);

    expect(() => cards.deleteSubtrees(['project'], { actor: 'runtime', surface: 'runtime' }, () => true)).toThrow(/cannot be deleted/);
    expect(publications).toEqual([]);
  });

  it('emits no effects when the parent link append reports failure after a complete line', () => {
    const eventBus = new EventBus(); const events = jest.fn(); eventBus.subscribe('card_history_appended', (event) => { events(event); });
    const changes = new ReadModelChangeBroadcaster(); const publications: string[] = [];
    changes.subscribe({ cardStateChanged: () => publications.push('card'), runtimeChanged: () => publications.push('runtime'), agentsChanged() {}, conversationChanged() {} });
    const operations: string[] = [];
    const afterFailure: string[] = [];
    let failed = false;
    const record = (operation: string) => { operations.push(operation); if (failed) afterFailure.push(operation); };
    const tracedRead = ((...args: unknown[]) => {
      record('read');
      return Reflect.apply(readFileSync, undefined, args);
    }) as typeof readFileSync;
    const tracedWrite = ((...args: unknown[]) => {
      record('write');
      return Reflect.apply(writeSync, undefined, args);
    }) as typeof writeSync;
    const io: GrowingFileIo = {
      read: tracedRead,
      open(path, flags) { record('open'); return openSync(path, flags); },
      write: tracedWrite,
      fsync(fd) {
        record('fsync');
        fsyncSync(fd);
        failed = true;
        throw new Error('parent link fsync');
      },
      truncate(fd, length) { record('truncate'); ftruncateSync(fd, length); },
      close(fd) { record('close'); closeSync(fd); },
    };
    const cards = new CardService(root, eventBus, changes, () => FIRST_SEGMENT, io);
    expect(() => cards.create(input())).toThrow('parent link fsync');
    expect(publications).toEqual([]);
    expect(events).not.toHaveBeenCalled();
    expect(operations).toEqual(['open', 'write', 'fsync', 'close']);
    expect(afterFailure).toEqual(['close']);
  });

  it.each(['blocked', 'done', 'failed', 'cancelled'] as const)('rechecks fresh parent status admission before claiming a child namespace (%s)', (value) => {
    const initial = new CardService(root, undefined, undefined, () => FIRST_SEGMENT);
    const parent = initial.create({ ...input(), type: 'goal' });
    const identity = jest.fn(() => {
      initial.setStatus(parent.id, 'running');
      if (value === 'blocked') initial.commitTerminalLifecyclePatch(parent.id, { status: value, lifecycle: { status: value, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'test' }, error: 'blocked', completed_at: null } });
      else if (value === 'cancelled') initial.setStatus(parent.id, value);
      else initial.commitTerminalLifecyclePatch(parent.id, { status: value, lifecycle: value === 'done' ? { status: value, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-17T00:00:00.000Z' } : { status: value, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-17T00:00:00.000Z' } });
      return SECOND_SEGMENT;
    });
    const creating = new CardService(root, undefined, undefined, identity);
    expect(() => creating.create(input(parent.id))).toThrow(/Cannot claim a child namespace under/);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(creating.listChildren(parent.id)).toEqual([]);
  });
});

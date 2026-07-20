import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { closeSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import type { CardPatch, NewCardInput, TerminalLifecyclePatch } from '../../src/cards/lifecycle.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { EventBus } from '../../src/events/index.js';
import { cardStreamFile } from '../../src/persistence/layout.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { computeCardLogicalPath } from '../../src/application/read-models/card-view.js';

const FIRST_SEGMENT = 'a';
const SECOND_SEGMENT = 'b';
const THIRD_SEGMENT = 'c';
const FIRST = `card-${FIRST_SEGMENT}`;
const SECOND = `card-${SECOND_SEGMENT}`;
const THIRD = `card-${THIRD_SEGMENT}`;

function input(parent = 'project'): NewCardInput {
  return {
    type: 'code', parent, title: 'Implement final contract', brief: 'Use direct card I/O.',
    status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
  };
}

function terminalPatch(status: TerminalLifecyclePatch['status'], withStatusText = false): TerminalLifecyclePatch {
  const companions = withStatusText
    ? { status_text: `${status} summary`, status_text_updated_at: '2026-07-19T00:00:01.000Z' }
    : {};
  switch (status) {
    case 'done':
      return { status, lifecycle: { status, result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-19T00:00:00.000Z' }, ...companions };
    case 'failed':
      return { status, lifecycle: { status, result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-19T00:00:00.000Z' }, ...companions };
    case 'blocked':
      return { status, lifecycle: { status, result: { kind: 'blocked', summary: 'blocked', resume_reason: 'test' }, error: 'blocked', completed_at: null }, ...companions };
  }
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
    cardProjectionChanged: () => publications.push(snapshot('card')),
    runtimeChanged: () => publications.push(snapshot('runtime')),
    agentsChanged: () => undefined,
    conversationChanged: () => undefined,
  });
  cards = new CardService(root, eventBus, changes);
  return { cards, publications, historyEvents };
}

describe('CardService final reset-only contracts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-card-service-')); initProjectTree(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('allocates parent-local spreadsheet identities', () => {
    const cards = new CardService(root);
    expect(cards.create({ ...input(), type: 'goal' }).id).toBe(FIRST);
    expect(cards.create(input()).id).toBe(SECOND);
    expect(cards.listChildren('project')).toEqual([FIRST, SECOND]);
    expect(new CardService(root).create(input(FIRST)).id).toBe(`${FIRST}-a`);
  });

  it('lists and reorders only the exact parent and its committed child references', () => {
    const cards = new CardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });
    const child = cards.create(input(parent.id));
    const unrelated = cards.create(input());
    writeFileSync(cardStreamFile(root, unrelated.id), '{complete-malformed}\n');

    expect(cards.listChildren(parent.id)).toEqual([child.id]);
    expect(cards.reorderChildren(parent.id, [child.id], { actor: 'analyst', surface: 'runtime', reason: 'exact reorder' })).toEqual({ ok: true, changed: 0 });
    expect(() => cards.list()).toThrow();
  });

  it('admits a fresh parent and confirms the linked child before history/card/runtime effects', () => {
    const parent = new CardService(root).create({ ...input(), type: 'goal' });
    const childId = `${parent.id}-${FIRST_SEGMENT}`;
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
      cardProjectionChanged: () => { order.push('card'); assertLinkedVisibility(); },
      runtimeChanged: () => { order.push('runtime'); assertLinkedVisibility(); },
      agentsChanged() {},
      conversationChanged() {},
    });
    const writeParentLink = ((...args: unknown[]) => {
      order.push('parent-link-write');
      return Reflect.apply(writeSync, undefined, args);
    }) as typeof writeSync;
    const io: GrowingFileIo = {
      open(path, flags) {
        order.push('parent-link-open');
        const observer = new CardService(root);
        expect(observer.read(parent.id)?.children).toEqual([]);
        expect(observer.listChildren(parent.id)).toEqual([]);
        expect(observer.list().map(({ id }) => id)).toEqual(['project', parent.id]);
        expect(observer.read(childId)).toBeNull();
        return openSync(path, flags);
      },
      stat: fstatSync,
      write: writeParentLink,
      fsync(fd) { order.push('parent-link-fsync'); fsyncSync(fd); },
      close(fd) { order.push('parent-link-close'); closeSync(fd); },
    };
    const cards = new CardService(root, eventBus, changes, io);

    const child = cards.create(input(parent.id));

    expect(child.id).toBe(childId);
    // Reaching the append means publishInitialCard completed its initial-stream proof,
    // CardService freshly admitted the still-unlinked parent, and its second proof returned.
    expect(order).toEqual([
      'parent-link-open', 'parent-link-write', 'parent-link-fsync', 'parent-link-close',
      'history', 'card', 'card', 'card', 'card', 'card', 'runtime',
    ]);
  });

  it('projects a cloned target and dependency statuses in declared order', () => {
    const cards = new CardService(root);
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

  it('uses only the narrow source-checked running and stopped lifecycle operations', () => {
    const cards = new CardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });

    expect(() => cards.stopRunningForRecovery(parent.id)).toThrow(/must be running/);
    cards.setStatus(parent.id, 'running');
    expect(() => cards.setStatus(parent.id, 'stopped')).toThrow(/Invalid transition/);
    expect(() => cards.mutateCard(parent.id, { status: 'stopped', lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } }, { actor: 'runtime', surface: 'runtime', reason: 'status -> stopped' })).toThrow(/Generic card mutation/);

    expect(cards.stopRunningForRecovery(parent.id)).toMatchObject({ status: 'stopped', lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } });
    expect(() => cards.stopRunningForRecovery(parent.id)).toThrow(/must be running/);
    expect(() => cards.setStatus(parent.id, 'running')).toThrow(/Invalid transition/);
    expect(() => cards.mutateCard(parent.id, { status: 'running', lifecycle: { status: 'running', result: null, error: null, completed_at: null } }, { actor: 'runtime', surface: 'runtime', reason: 'status -> running' })).toThrow(/Generic card mutation/);

    cards.mutateCard(parent.id, { title: 'Edited while stopped' }, { actor: 'analyst', surface: 'web-chat', reason: 'stopped edit' });
    expect(cards.read(parent.id)).toMatchObject({ status: 'stopped', title: 'Edited while stopped' });
    expect(cards.create(input(parent.id))).toMatchObject({ parent: parent.id, status: 'backlog' });
    expect(cards.activateStopped(parent.id)).toMatchObject({ status: 'running', lifecycle: { status: 'running', result: null, error: null, completed_at: null } });
    expect(() => cards.activateStopped(parent.id)).toThrow(/must be stopped/);

    const history = cards.listCardHistory(parent.id);
    expect(history.kind).toBe('found');
    if (history.kind !== 'found') throw new Error('expected history');
    expect(history.value.filter(({ change_reason }) => change_reason === 'recovery stopped lifecycle')).toHaveLength(1);
    expect(history.value.filter(({ change_reason }) => change_reason === 'STOPPED activation')).toHaveLength(1);
    expect(history.value.filter(({ change_reason }) => change_reason === 'recovery stopped lifecycle' || change_reason === 'STOPPED activation'))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ kind: 'status', changed_by_actor: 'runtime', changed_by_surface: 'runtime', changed_fields: ['status', 'lifecycle'], change_reason: 'recovery stopped lifecycle' }),
        expect.objectContaining({ kind: 'status', changed_by_actor: 'runtime', changed_by_surface: 'runtime', changed_fields: ['status', 'lifecycle'], change_reason: 'STOPPED activation' }),
      ]));
  });

  it.each(['terminal lifecycle commit', 'status -> running', 'recovery stopped lifecycle', 'STOPPED activation'])('treats generic caller reason %s as audit prose without lifecycle authority', (reason) => {
    const { cards, publications, historyEvents } = observableCardService(root);
    cards.create(input());
    const streamBefore = readFileSync(cardStreamFile(root, FIRST), 'utf8');
    const eventsBefore = historyEvents.length;
    publications.length = 0;

    expect(() => cards.mutateCard(FIRST, {
      status: 'running',
      lifecycle: { status: 'running', result: null, error: null, completed_at: null },
    }, { actor: 'runtime', surface: 'runtime', reason })).toThrow(/lifecycle-owned/);

    expect(readFileSync(cardStreamFile(root, FIRST), 'utf8')).toBe(streamBefore);
    expect(cards.read(FIRST)).toMatchObject({ status: 'backlog', version_seq: 1 });
    expect(cards.listCardHistory(FIRST)).toEqual({ kind: 'found', value: [] });
    expect(historyEvents).toHaveLength(eventsBefore);
    expect(publications).toEqual([]);
  });

  it('prunes equal ordinary lifecycle values without granting authority or losing a companion edit', () => {
    const cards = new CardService(root);
    const card = cards.create(input());

    const edited = cards.mutateCard(card.id, {
      status: card.status,
      lifecycle: card.lifecycle,
      title: 'Ordinary edit after lifecycle pruning',
    }, { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' });

    expect(edited).toMatchObject({ status: 'backlog', lifecycle: card.lifecycle, title: 'Ordinary edit after lifecycle pruning', version_seq: 2 });
    const streamBeforeNoOp = readFileSync(cardStreamFile(root, card.id), 'utf8');
    expect(cards.mutateCard(card.id, { status: edited.status, lifecycle: edited.lifecycle }, { actor: 'runtime', surface: 'runtime', reason: 'STOPPED activation' })).toEqual(edited);
    expect(readFileSync(cardStreamFile(root, card.id), 'utf8')).toBe(streamBeforeNoOp);
  });

  it.each(['done', 'failed', 'blocked'] as const)('commits a strict running-to-%s lifecycle with the canonical context', (status) => {
    const cards = new CardService(root);
    const card = cards.create(input());
    cards.setStatus(card.id, 'running');

    const committed = cards.commitTerminalLifecyclePatch(card.id, terminalPatch(status, status === 'failed'));

    expect(committed.status).toBe(status);
    expect(committed.lifecycle.status).toBe(status);
    if (status === 'failed') expect(committed).toMatchObject({ status_text: 'failed summary', status_text_updated_at: '2026-07-19T00:00:01.000Z' });
    else expect(committed).toMatchObject({ status_text: null, status_text_updated_at: null });
    const history = cards.listCardHistory(card.id);
    expect(history.kind).toBe('found');
    if (history.kind !== 'found') throw new Error('expected history');
    expect(history.value.find(({ change_reason }) => change_reason === 'terminal lifecycle commit')).toMatchObject({ kind: 'mutate', changed_by_actor: 'runtime', changed_by_surface: 'runtime', change_reason: 'terminal lifecycle commit' });
  });

  it.each(['backlog', 'changed', 'blocked', 'stopped', 'done', 'failed', 'cancelled'] as const)('rejects terminal commit from %s without append or effects', (source) => {
    const { cards, publications, historyEvents } = observableCardService(root);
    const card = cards.create(input());
    if (source === 'changed') { cards.setStatus(card.id, 'running'); cards.setStatus(card.id, 'changed'); }
    if (source === 'blocked') { cards.setStatus(card.id, 'running'); cards.setStatus(card.id, 'blocked'); }
    if (source === 'stopped') { cards.setStatus(card.id, 'running'); cards.stopRunningForRecovery(card.id); }
    if (source === 'done' || source === 'failed') { cards.setStatus(card.id, 'running'); cards.commitTerminalLifecyclePatch(card.id, terminalPatch(source)); }
    if (source === 'cancelled') cards.setStatus(card.id, 'cancelled');
    const streamBefore = readFileSync(cardStreamFile(root, card.id), 'utf8');
    const eventsBefore = historyEvents.length;
    publications.length = 0;

    expect(() => cards.commitTerminalLifecyclePatch(card.id, terminalPatch('done'))).toThrow(/must be running/);

    expect(readFileSync(cardStreamFile(root, card.id), 'utf8')).toBe(streamBefore);
    expect(historyEvents).toHaveLength(eventsBefore);
    expect(publications).toEqual([]);
  });

  it('rejects every nonterminal target, status/lifecycle mismatch, and malformed terminal lifecycle at runtime', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    const card = cards.create(input());
    cards.setStatus(card.id, 'running');
    const invalidPatches: unknown[] = [
      { status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } },
      { status: 'running', lifecycle: { status: 'running', result: null, error: null, completed_at: null } },
      { status: 'changed', lifecycle: { status: 'changed', result: null, error: null, completed_at: null } },
      { status: 'stopped', lifecycle: { status: 'stopped', result: null, error: null, completed_at: null } },
      { status: 'cancelled', lifecycle: { status: 'cancelled', result: null, error: null, completed_at: null } },
      { status: 'done', lifecycle: terminalPatch('failed').lifecycle },
      { status: 'done', lifecycle: { status: 'done', result: null, error: null, completed_at: null } },
      { status: 'failed', lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'failed' }, error: null, completed_at: '2026-07-19T00:00:00.000Z' } },
      { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'blocked' }, error: 'blocked', completed_at: '2026-07-19T00:00:00.000Z' } },
    ];
    const streamBefore = readFileSync(cardStreamFile(root, card.id), 'utf8');
    const eventsBefore = historyEvents.length;
    publications.length = 0;

    for (const patch of invalidPatches) {
      expect(() => cards.commitTerminalLifecyclePatch(card.id, patch as TerminalLifecyclePatch)).toThrow();
    }

    expect(readFileSync(cardStreamFile(root, card.id), 'utf8')).toBe(streamBefore);
    expect(historyEvents).toHaveLength(eventsBefore);
    expect(publications).toEqual([]);
  });

  it('rejects every terminal-commit field outside the two status-text companions', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    const card = cards.create(input());
    cards.setStatus(card.id, 'running');
    const forbiddenFields = [
      'id', 'type', 'parent', 'depth', 'children', 'title', 'subtype', 'tags', 'priority', 'urgency',
      'created_by', 'created_at', 'updated_at', 'version_seq', 'assigned_to', 'depends_on', 'related',
      'metrics', 'estimate', 'started_at', 'duration_ms', 'status_text_author_session_id', 'latest_self_report',
      'metadata', 'pending_notifications',
    ];
    const streamBefore = readFileSync(cardStreamFile(root, card.id), 'utf8');
    const eventsBefore = historyEvents.length;
    publications.length = 0;

    for (const field of forbiddenFields) {
      const patch = { ...terminalPatch('done'), [field]: 'forbidden' };
      expect(() => cards.commitTerminalLifecyclePatch(card.id, patch as TerminalLifecyclePatch)).toThrow();
    }

    expect(readFileSync(cardStreamFile(root, card.id), 'utf8')).toBe(streamBefore);
    expect(historyEvents).toHaveLength(eventsBefore);
    expect(publications).toEqual([]);
  });

  it('rejects missing dependencies before claiming a child namespace', () => {
    const cards = new CardService(root);
    expect(() => cards.create({ ...input(), depends_on: [SECOND] })).toThrow(`Dependency card '${SECOND}' does not exist.`);
    expect(readFileSync(cardStreamFile(root, 'project'), 'utf8').trim().split('\n')).toHaveLength(1);
    expect(() => readFileSync(cardStreamFile(root, FIRST))).toThrow();
  });

  it('keeps directory allocation independent from parent-owned sibling order', () => {
    const cards = new CardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });
    const first = cards.create(input(parent.id));
    const second = cards.create(input(parent.id));
    cards.reorderChildren(parent.id, [second.id, first.id], { actor: 'analyst', surface: 'runtime', reason: 'test' });
    expect(cards.create(input(parent.id)).id).toBe(`${parent.id}-${THIRD_SEGMENT}`);
  });

  it('publishes and links a child under an unresolved blocked planning parent', () => {
    const cards = new CardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });
    cards.setStatus(parent.id, 'running');
    cards.commitTerminalLifecyclePatch(parent.id, { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'blocked', resume_reason: 'test' }, error: 'blocked', completed_at: null } });

    const child = cards.create(input(parent.id));

    expect(child).toMatchObject({ id: `${parent.id}-a`, parent: parent.id, status: 'backlog' });
    expect(cards.listChildren(parent.id)).toEqual([child.id]);
    expect(cards.read(parent.id)?.children).toEqual([child.id]);
  });

  it.each(['done', 'failed', 'cancelled'] as const)('rejects a %s parent before claiming its next child', (status) => {
    const cards = new CardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });
    cards.setStatus(parent.id, 'running');
    if (status === 'cancelled') cards.setStatus(parent.id, status);
    else if (status === 'done') cards.commitTerminalLifecyclePatch(parent.id, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-07-17T00:00:00.000Z' } });
    else cards.commitTerminalLifecyclePatch(parent.id, { status: 'failed', lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'failed' }, error: 'failed', completed_at: '2026-07-17T00:00:00.000Z' } });
    const rowsBefore = readFileSync(cardStreamFile(root, parent.id), 'utf8');

    expect(() => cards.create(input(parent.id))).toThrow(/Cannot create a child under/);
    expect(readFileSync(cardStreamFile(root, parent.id), 'utf8')).toBe(rowsBefore);
    expect(cards.listChildren(parent.id)).toEqual([]);
    expect(() => readFileSync(cardStreamFile(root, `${parent.id}-a`))).toThrow();
  });

  it('treats an occupied candidate as consumed without changing it', () => {
    const orphan = join(root, '.saivage', 'cards', 'project', 'children', FIRST_SEGMENT);
    mkdirSync(join(root, '.saivage', 'cards', 'project', 'children'));
    writeFileSync(orphan, 'opaque occupied candidate');
    const cards = new CardService(root);

    expect(cards.create(input()).id).toBe(SECOND);
    expect(readFileSync(orphan, 'utf8')).toBe('opaque occupied candidate');
    expect(cards.listChildren('project')).toEqual([SECOND]);
  });

  it('propagates malformed canonical card artifacts', () => {
    writeFileSync(join(root, '.saivage', 'cards', 'project', 'card.jsonl'), '{malformed}\n');
    expect(() => new CardService(root).readActivationAdmission('project')).toThrow();
  });

  it.each(['backlog', 'running', 'changed', 'blocked', 'stopped'] as const)('preserves notifications while %s remains unresolved', (status) => {
    const cards = new CardService(root);
    cards.create(input());
    if (status !== 'backlog') {
      cards.setStatus(FIRST, 'running');
      if (status === 'changed') cards.setStatus(FIRST, 'changed');
      if (status === 'blocked') cards.commitTerminalLifecyclePatch(FIRST, { status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'wait', resume_reason: 'wait' }, error: 'wait', completed_at: null } });
      if (status === 'stopped') cards.stopRunningForRecovery(FIRST);
    }
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'new facts', created_at: '2026-07-15T00:00:00.000Z' });
    expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n1']);
    if (status === 'blocked') {
      cards.setStatus(FIRST, 'running');
      expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n1']);
    }
  });

  it.each(['done', 'failed', 'cancelled'] as const)('clears notifications and rejects enqueue after %s', (status) => {
    const cards = new CardService(root);
    cards.create(input());
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'new facts', created_at: '2026-07-15T00:00:00.000Z' });
    cards.setStatus(FIRST, 'running');
    if (status === 'cancelled') cards.setStatus(FIRST, status);
    else if (status === 'done') cards.commitTerminalLifecyclePatch(FIRST, { status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'ok' }, error: null, completed_at: '2026-07-15T00:00:01.000Z' } });
    else cards.commitTerminalLifecyclePatch(FIRST, { status: 'failed', lifecycle: { status: 'failed', result: { kind: 'failed', summary: 'bad' }, error: 'bad', completed_at: '2026-07-15T00:00:01.000Z' } });
    expect(cards.read(FIRST)?.pending_notifications).toEqual([]);
    expect(() => cards.enqueueNotification(FIRST, { id: 'n2', content: 'late', created_at: '2026-07-15T00:00:02.000Z' })).toThrow(/terminal card/);
  });

  it('removes exactly selected notification ids and preserves later entries', () => {
    const cards = new CardService(root);
    cards.create(input());
    cards.enqueueNotification(FIRST, { id: 'n1', content: 'one', created_at: '2026-07-15T00:00:00.000Z' });
    cards.enqueueNotification(FIRST, { id: 'n2', content: 'two', created_at: '2026-07-15T00:00:01.000Z' });
    cards.removeNotifications(FIRST, ['n1']);
    expect(cards.read(FIRST)?.pending_notifications.map(({ id }) => id)).toEqual(['n2']);
  });

  it('publishes card then runtime synchronously after create and delete are readable', () => {
    const { cards, publications } = observableCardService(root);

    cards.create(input());
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'runtime']);
    expect(publications.every(({ card, listedIds }) => card?.id === FIRST && listedIds.includes(FIRST))).toBe(true);
    expect(publications.every(({ byType }) => byType.code?.includes(FIRST))).toBe(true);

    publications.length = 0;
    cards.deleteSubtrees([FIRST], { actor: 'runtime', surface: 'runtime' }, () => true);
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card', 'card', 'card', 'card', 'runtime']);
    expect(publications.every(({ card, listedIds, byType }) => card === null && listedIds.length === 1 && listedIds[0] === 'project' && byType.project?.[0] === 'project')).toBe(true);
  });

  it('publishes runtime exactly once for actual status patches and not ordinary edits', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    cards.setStatus(FIRST, 'running');
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card', 'runtime']);
    expect(publications.every(({ card }) => card?.status === 'running')).toBe(true);

    cards.setStatus(FIRST, 'backlog');
    publications.length = 0;
    cards.update(FIRST, { title: 'Edited without changing runtime indexes' });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card']);
    expect(publications[0]?.card).toMatchObject({ type: 'code', title: 'Edited without changing runtime indexes' });

    cards.setStatus(FIRST, 'running');
    publications.length = 0;
    cards.commitTerminalLifecyclePatch(FIRST, {
      status: 'done',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'complete' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' },
    });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card', 'runtime']);
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
    expect(cards.listCardHistory(FIRST)).toEqual({ kind: 'found', value: [] });
  });

  it('rejects forged children patches before no-op pruning on every generic patch path', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    cards.create(input());
    const beforeEvents = historyEvents.length;
    publications.length = 0;

    expect(() => cards.update(FIRST, { children: [] } as unknown as CardPatch)).toThrow("Field 'children' cannot be changed");
    expect(() => cards.mutateCard(FIRST, { children: [SECOND] } as unknown as CardPatch, { actor: 'analyst', surface: 'web-chat' })).toThrow("Field 'children' cannot be changed");
    expect(publications).toEqual([]);
    expect(historyEvents).toHaveLength(beforeEvents);
    expect(cards.read(FIRST)).toMatchObject({ children: [], version_seq: 1 });
  });

  it('reorders with one parent append, leaves child streams unchanged, and survives a fresh ordered read', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    const parent = cards.create({ ...input(), type: 'goal' });
    const first = cards.create(input(parent.id));
    const second = cards.create(input(parent.id));
    const parentPath = cardStreamFile(root, parent.id);
    const firstBefore = readFileSync(cardStreamFile(root, first.id), 'utf8');
    const secondBefore = readFileSync(cardStreamFile(root, second.id), 'utf8');
    const parentRowsBefore = readFileSync(parentPath, 'utf8').trim().split('\n').length;
    publications.length = 0;
    historyEvents.length = 0;

    expect(cards.reorderChildren(parent.id, [second.id, first.id], { actor: 'analyst', surface: 'runtime', reason: 'test reorder' })).toEqual({ ok: true, changed: 2 });

    expect(historyEvents).toEqual([parent.id]);
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card']);
    expect(readFileSync(parentPath, 'utf8').trim().split('\n')).toHaveLength(parentRowsBefore + 1);
    expect(readFileSync(cardStreamFile(root, first.id), 'utf8')).toBe(firstBefore);
    expect(readFileSync(cardStreamFile(root, second.id), 'utf8')).toBe(secondBefore);
    const restarted = new CardService(root);
    expect(restarted.listChildren(parent.id)).toEqual([second.id, first.id]);
    const history = restarted.listCardHistory(parent.id);
    expect(history.kind).toBe('found');
    if (history.kind !== 'found') throw new Error('expected history');
    expect(history.value[0]).toMatchObject({ kind: 'mutate', changed_fields: ['children'], change_summary: 'children reordered' });
    expect(computeCardLogicalPath(restarted, restarted.read(second.id)!)).toBe('1.1');
    expect(computeCardLogicalPath(restarted, restarted.read(first.id)!)).toBe('1.2');
  });

  it('keeps reorder no-op and mismatch paths silent', () => {
    const { cards, publications, historyEvents } = observableCardService(root);
    const first = cards.create(input());
    const second = cards.create(input());
    const beforeEvents = historyEvents.length;
    const rootRows = readFileSync(cardStreamFile(root, 'project'), 'utf8');
    publications.length = 0;

    expect(cards.reorderChildren('project', [first.id, second.id], { actor: 'analyst', surface: 'runtime' })).toEqual({ ok: true, changed: 0 });
    expect(cards.reorderChildren('project', [first.id, first.id], { actor: 'analyst', surface: 'runtime' })).toEqual({ ok: false, reason: 'ordered child ids do not match current children', missing: [second.id], extra: [] });
    expect(cards.reorderChildren('project', [first.id, THIRD], { actor: 'analyst', surface: 'runtime' })).toEqual({ ok: false, reason: 'ordered child ids do not match current children', missing: [second.id], extra: [THIRD] });
    expect(readFileSync(cardStreamFile(root, 'project'), 'utf8')).toBe(rootRows);
    expect(publications).toEqual([]);
    expect(historyEvents).toHaveLength(beforeEvents);
  });

  it('moves active children first while retaining tombstoned links stably, but does not rewrite retained links for an active no-op', () => {
    const cards = new CardService(root);
    const first = cards.create(input());
    const retainedOne = cards.create(input());
    const second = cards.create(input());
    const retainedTwo = cards.create(input());
    cards.deleteSubtrees([retainedOne.id, retainedTwo.id], { actor: 'analyst', surface: 'runtime' }, () => true);
    const noOpRows = readFileSync(cardStreamFile(root, 'project'), 'utf8');

    expect(cards.reorderChildren('project', [first.id, second.id], { actor: 'analyst', surface: 'runtime' })).toEqual({ ok: true, changed: 0 });
    expect(readFileSync(cardStreamFile(root, 'project'), 'utf8')).toBe(noOpRows);
    expect(cards.read('project')?.children).toEqual([first.id, retainedOne.id, second.id, retainedTwo.id]);

    expect(cards.reorderChildren('project', [second.id, first.id], { actor: 'analyst', surface: 'runtime' })).toEqual({ ok: true, changed: 2 });
    expect(cards.read('project')?.children).toEqual([second.id, first.id, retainedOne.id, retainedTwo.id]);
    expect(cards.listChildren('project')).toEqual([second.id, first.id]);
  });

  it('keeps no-op patches silent and real non-index updates card-only', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    cards.setStatus(FIRST, 'backlog');
    cards.update(FIRST, {});
    expect(publications).toEqual([]);

    cards.update(FIRST, { status: 'backlog', title: 'Updated title' });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'card', 'card', 'card', 'card']);
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
    changes.subscribe({ cardProjectionChanged: () => publications.push('card'), runtimeChanged: () => publications.push('runtime'), agentsChanged() {}, conversationChanged() {} });
    const operations: string[] = [];
    const afterFailure: string[] = [];
    let failed = false;
    const record = (operation: string) => { operations.push(operation); if (failed) afterFailure.push(operation); };
    const tracedWrite = ((...args: unknown[]) => {
      record('write');
      return Reflect.apply(writeSync, undefined, args);
    }) as typeof writeSync;
    const io: GrowingFileIo = {
      open(path, flags) { record('open'); return openSync(path, flags); },
      stat(fd) { record('stat'); return fstatSync(fd); },
      write: tracedWrite,
      fsync(fd) {
        record('fsync');
        fsyncSync(fd);
        failed = true;
        throw new Error('parent link fsync');
      },
      close(fd) { record('close'); closeSync(fd); },
    };
    const cards = new CardService(root, eventBus, changes, io);
    expect(() => cards.create(input())).toThrow('parent link fsync');
    expect(publications).toEqual([]);
    expect(events).not.toHaveBeenCalled();
    expect(operations).toEqual(['open', 'stat', 'write', 'fsync', 'close']);
    expect(afterFailure).toEqual(['close']);
  });

  it('emits no effects or post-error persistence work when a reorder append reports failure', () => {
    const setup = new CardService(root);
    const first = setup.create(input());
    const second = setup.create(input());
    const eventBus = new EventBus();
    const events = jest.fn();
    eventBus.subscribe('card_history_appended', (event) => { events(event); });
    const changes = new ReadModelChangeBroadcaster();
    const publications: string[] = [];
    changes.subscribe({ cardProjectionChanged: () => publications.push('card'), runtimeChanged: () => publications.push('runtime'), agentsChanged() {}, conversationChanged() {} });
    const operations: string[] = [];
    const afterFailure: string[] = [];
    let failed = false;
    const record = (operation: string) => { operations.push(operation); if (failed) afterFailure.push(operation); };
    const io: GrowingFileIo = {
      open(path, flags) { record('open'); return openSync(path, flags); },
      stat(fd) { record('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => { record('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { record('fsync'); fsyncSync(fd); failed = true; throw new Error('reorder fsync'); },
      close(fd) { record('close'); closeSync(fd); },
    };
    const cards = new CardService(root, eventBus, changes, io);

    expect(() => cards.reorderChildren('project', [second.id, first.id], { actor: 'analyst', surface: 'runtime' })).toThrow('reorder fsync');
    expect(events).not.toHaveBeenCalled();
    expect(publications).toEqual([]);
    expect(operations).toEqual(['open', 'stat', 'write', 'fsync', 'close']);
    expect(afterFailure).toEqual(['close']);
  });

});

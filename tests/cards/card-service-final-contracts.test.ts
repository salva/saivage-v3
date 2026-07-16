import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardService } from '../../src/cards/card-service.js';
import type { NewCardInput } from '../../src/cards/lifecycle.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';

function input(parent = 'project'): NewCardInput {
  return {
    type: 'code', parent, depth: 1, title: 'Implement final contract', brief: 'Use direct card I/O.',
    status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [],
  };
}

type PublicationSnapshot = {
  kind: 'card' | 'runtime';
  card: ReturnType<CardService['read']>;
  listedIds: string[];
};

function observableCardService(root: string): { cards: CardService; publications: PublicationSnapshot[] } {
  const changes = new ReadModelChangeBroadcaster();
  const publications: PublicationSnapshot[] = [];
  let cards!: CardService;
  changes.subscribe({
    cardStateChanged: () => publications.push({ kind: 'card', card: cards.read(FIRST), listedIds: cards.list().map(({ id }) => id) }),
    runtimeChanged: () => publications.push({ kind: 'runtime', card: cards.read(FIRST), listedIds: cards.list().map(({ id }) => id) }),
    agentsChanged: () => undefined,
    conversationChanged: () => undefined,
  });
  cards = new CardService(root, undefined, changes, () => FIRST);
  return { cards, publications };
}

describe('CardService final reset-only contracts', () => {
  let root: string;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'saivage-card-service-')); initProjectTree(root); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uses one opaque identity per creation attempt and never derives identity from existing namespaces', () => {
    const identity = jest.fn<() => string>().mockReturnValueOnce(FIRST).mockReturnValueOnce(SECOND);
    const cards = new CardService(root, undefined, undefined, identity);
    expect(cards.create(input()).id).toBe(FIRST);
    expect(cards.create(input()).id).toBe(SECOND);
    expect(identity).toHaveBeenCalledTimes(2);
    expect(cards.listChildren('project')).toEqual([FIRST, SECOND]);
  });

  it.each(['backlog', 'running', 'changed', 'blocked'] as const)('preserves notifications while %s remains unresolved', (status) => {
    const cards = new CardService(root, undefined, undefined, () => FIRST);
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
    const cards = new CardService(root, undefined, undefined, () => FIRST);
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
    const cards = new CardService(root, undefined, undefined, () => FIRST);
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

    publications.length = 0;
    cards.delete(FIRST);
    expect(publications).toEqual([
      { kind: 'card', card: null, listedIds: ['project'] },
      { kind: 'runtime', card: null, listedIds: ['project'] },
    ]);
  });

  it('publishes runtime exactly once for each actual pruned status or type patch', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    cards.setStatus(FIRST, 'running');
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card }) => card?.status === 'running')).toBe(true);

    cards.setStatus(FIRST, 'backlog');
    publications.length = 0;
    cards.update(FIRST, { type: 'test' });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card }) => card?.type === 'test')).toBe(true);

    publications.length = 0;
    cards.commitTerminalLifecyclePatch(FIRST, {
      status: 'done',
      type: 'doc',
      lifecycle: { status: 'done', result: { kind: 'done', summary: 'complete' }, error: null, completed_at: '2026-07-16T00:00:00.000Z' },
    });
    expect(publications.map(({ kind }) => kind)).toEqual(['card', 'runtime']);
    expect(publications.every(({ card }) => card?.status === 'done' && card.type === 'doc')).toBe(true);
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

  it('publishes no post-success hints when create, update, or delete fails', () => {
    const { cards, publications } = observableCardService(root);
    cards.create(input());

    publications.length = 0;
    expect(() => cards.create(input())).toThrow();
    expect(publications).toEqual([]);

    expect(() => cards.update(FIRST, { type: 'project' })).toThrow(/Cannot change card/);
    expect(publications).toEqual([]);

    expect(() => cards.delete('project')).toThrow(/Cannot tombstone the project card/);
    expect(publications).toEqual([]);
  });
});

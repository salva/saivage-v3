import { initProjectTree, CardStore } from '../helpers/canonical-project.js';
import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildNewCard,
  buildUpdatedCard,
  canTransition,
  collectChangedFields,
  isTerminalState,
  isTerminalType,
  newCardId,
  prunePartialPatch,
  summarizeChangedFields,
  validateMutablePatch,
  validateTransition,
} from '../../src/cards/lifecycle.js';

import type { CardLifecycleState, CardRecord } from '../../src/schemas/index.js';

function baseCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'backlog', result: null, error: null, completed_at: null } as CardLifecycleState);
  return {
    id: 'goal-1',
    type: 'goal',
    parent: 'project',
    depth: 1,
    position: 0,
    title: 'Goal',
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    assigned_to: null,
    depends_on: [],
    related: [],
    lifecycle,
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    version_seq: 1,
    ...overrides,
  };
}

describe('card lifecycle domain rules', () => {
  it('validates status transitions without a CardStore or filesystem', () => {
    expect(canTransition('backlog', 'running')).toBe(true);
    expect(canTransition('backlog', 'done')).toBe(false);
    expect(() => validateTransition('backlog', 'done')).toThrow(/Invalid transition: backlog/);
  });

  it('allows mutable terminal cards to become changed but keeps cancelled terminal', () => {
    expect(canTransition('done', 'changed')).toBe(true);
    expect(canTransition('failed', 'changed')).toBe(true);
    expect(canTransition('cancelled', 'changed')).toBe(false);
  });

  it('owns terminal type and state predicates', () => {
    expect(isTerminalType('code')).toBe(true);
    expect(isTerminalType('goal')).toBe(false);
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('running')).toBe(false);
  });

  it('prunes no-op patch fields before editability checks', () => {
    const card = baseCard({ status: 'running' });
    const pruned = prunePartialPatch(card, { title: 'Goal', depends_on: [] });
    expect(pruned).toEqual({});
  });

  it('rejects structural edits on status-locked cards', () => {
    const card = baseCard({ status: 'running' });
    expect(() => validateMutablePatch(card, { depends_on: ['goal-2'] }, { childCount: 0 })).toThrow(/cannot be changed on a card in status 'running'/);
  });

  it('locks terminal lifecycle fields behind explicit commit or repair contexts', () => {
    const done = baseCard({ status: 'done', lifecycle: { status: 'done', result: { kind: 'done', summary: 'done' }, error: null, completed_at: '2026-01-01T00:10:00.000Z' } });
    expect(() => validateMutablePatch(done, { lifecycle: { ...done.lifecycle, error: 'stale' } as never }, { childCount: 0 })).toThrow(/lifecycle-owned/);
    expect(() => validateMutablePatch(done, { lifecycle: { ...done.lifecycle, result: { ok: false } } as never }, { childCount: 0 }, { actor: 'analyst', surface: 'web-chat', reason: 'analyst edit' })).toThrow(/lifecycle-owned/);
    expect(() => validateMutablePatch(done, { lifecycle: { ...done.lifecycle, completed_at: '2026-01-01T00:11:00.000Z' } as never }, { childCount: 0 }, { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' })).not.toThrow();
    expect(() => validateMutablePatch(done, { lifecycle: { ...done.lifecycle, error: null } as never }, { childCount: 0 }, { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle repair' })).not.toThrow();
  });

  it('allows restart patches to clear lifecycle fields while reopening', () => {
    const blocked = baseCard({ status: 'blocked', lifecycle: { status: 'blocked', result: { kind: 'blocked', summary: 'blocked', resume_reason: 'blocked' }, error: 'blocked', completed_at: null } });
    expect(() => validateMutablePatch(blocked, { status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } }, { childCount: 0 }, { actor: 'runtime', surface: 'runtime', reason: 'status -> backlog' })).not.toThrow();
  });

  it('rejects project-card type drift and nested project creation identity', () => {
    expect(newCardId('project', () => 'unused')).toBe('project');
    expect(() => validateMutablePatch(baseCard(), { type: 'project' }, { childCount: 0 })).toThrow(/canonical id 'project'|type 'project'/);
    expect(() => validateMutablePatch(baseCard({ id: 'project', type: 'project' }), { type: 'goal' }, { childCount: 0 })).toThrow(/canonical project card/);
  });

  it('builds updated cards and changed-field summaries purely', () => {
    const card = baseCard();
    const next = buildUpdatedCard(card, { title: 'New title', status_text: 'working' }, '2026-01-02T00:00:00.000Z', { childCount: 0 });
    const changed = collectChangedFields(card, next, { title: 'New title', status_text: 'working' });
    expect(next.version_seq).toBe(2);
    expect(next.created_at).toBe(card.created_at);
    expect(changed).toEqual(['title', 'status_text']);
    expect(summarizeChangedFields(changed)).toBe('title, status_text updated');
  });

  it('builds new card records from adapter-supplied hierarchy facts', () => {
    const card = buildNewCard({
      id: 'goal-2',
      input: {
        ...baseCard({ id: 'ignored', title: 'Created', version_seq: 99 }),
        brief: 'Created',
      },
      depth: 2,
      position: 3,
      timestamp: '2026-01-03T00:00:00.000Z',
    });
    expect(card.id).toBe('goal-2');
    expect(card.depth).toBe(2);
    expect(card.position).toBe(3);
    expect(card.version_seq).toBe(1);
  });

  it('setStatus to blocked produces a schema-valid record', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-lifecycle-blocked-'));
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      const { id: _cardId, ...cardInput } = baseCard({ title: 'G' });
      const card = store.create({ ...cardInput, brief: 'G' });
      store.setStatus(card.id, 'running');
      store.setStatus(card.id, 'running');

      const blocked = store.setStatus(card.id, 'blocked');

      expect(blocked.status).toBe('blocked');
      expect(blocked.lifecycle.status).toBe('blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('setStatus refuses done/failed and directs callers to terminal commit', () => {
    const root = mkdtempSync(join(tmpdir(), 'card-lifecycle-terminal-refusal-'));
    try {
      initProjectTree(root);
      const store = new CardStore(root);
      const { id: _cardId, ...cardInput } = baseCard({ title: 'G3' });
      const card = store.create({ ...cardInput, brief: 'G3' });
      store.setStatus(card.id, 'running');
      store.setStatus(card.id, 'running');

      expect(() => store.setStatus(card.id, 'done')).toThrow(
        /terminal lifecycle commit|not supported/i,
      );
      expect(() => store.setStatus(card.id, 'failed')).toThrow(
        /terminal lifecycle commit|not supported/i,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

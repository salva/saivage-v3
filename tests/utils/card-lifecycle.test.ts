import { describe, it, expect } from '@jest/globals';
import {
  buildNewCard,
  buildUpdatedCard,
  canTransition,
  collectChangedFields,
  isTerminalState,
  isTerminalType,
  normalizeNewCardId,
  prunePartialPatch,
  summarizeChangedFields,
  validateMutablePatch,
  validateTransition,
} from '../../src/cards/lifecycle.js';
import type { CardRecord } from '../../src/schemas/types.js';

function baseCard(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: 'goal-1',
    type: 'goal',
    parent: 'project',
    depth: 1,
    position: 0,
    title: 'Goal',
    description: '',
    status: 'backlog',
    subtype: null,
    instructions_file: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    assigned_to: null,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    result: null,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error: null,
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
    expect(canTransition('backlog', 'active')).toBe(true);
    expect(canTransition('backlog', 'done')).toBe(false);
    expect(() => validateTransition('backlog', 'done')).toThrow(/Invalid transition: backlog/);
  });

  it('owns terminal type and state predicates', () => {
    expect(isTerminalType('code')).toBe(true);
    expect(isTerminalType('goal')).toBe(false);
    expect(isTerminalState('done')).toBe(true);
    expect(isTerminalState('running')).toBe(false);
  });

  it('prunes no-op patch fields before editability checks', () => {
    const card = baseCard({ status: 'active' });
    const pruned = prunePartialPatch(card, { title: 'Goal', depends_on: [] });
    expect(pruned).toEqual({});
  });

  it('rejects structural edits on status-locked cards', () => {
    const card = baseCard({ status: 'active' });
    expect(() => validateMutablePatch(card, { depends_on: ['goal-2'] }, { childCount: 0 })).toThrow(/cannot be changed on a card in status 'active'/);
  });

  it('locks terminal lifecycle fields behind explicit commit or repair contexts', () => {
    const done = baseCard({ status: 'done', result: { ok: true }, completed_at: '2026-01-01T00:10:00.000Z' });
    expect(() => validateMutablePatch(done, { error: 'stale' }, { childCount: 0 })).toThrow(/lifecycle-owned/);
    expect(() => validateMutablePatch(done, { result: { ok: false } }, { childCount: 0 }, { actor: 'analyst', surface: 'web-chat', reason: 'analyst edit' })).toThrow(/lifecycle-owned/);
    expect(() => validateMutablePatch(done, { completed_at: '2026-01-01T00:11:00.000Z' }, { childCount: 0 }, { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle commit' })).not.toThrow();
    expect(() => validateMutablePatch(done, { error: null }, { childCount: 0 }, { actor: 'runtime', surface: 'runtime', reason: 'terminal lifecycle repair' })).not.toThrow();
  });

  it('allows restart patches to clear lifecycle fields while reopening', () => {
    const blocked = baseCard({ status: 'blocked', result: { planning: { status: 'blocked' } }, error: 'blocked' });
    expect(() => validateMutablePatch(blocked, { status: 'backlog', result: null, error: null, completed_at: null }, { childCount: 0 })).not.toThrow();
  });

  it('rejects project-card type drift and nested project creation identity', () => {
    expect(normalizeNewCardId('project', 'root-spec-plan-project', () => 'unused')).toBe('project');
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
        id: 'explicit',
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
});

import { describe, expect, it } from '@jest/globals';
import { PlannerResultApplier } from '../../src/runtime/phases/planner-result-applier.js';
import type { CardRecord } from '../../src/schemas/types.js';

describe('PlannerResultApplier', () => {
  it('creates new planner cards and updates tracked fields/status', async () => {
    const created: unknown[] = [];
    const mutated: unknown[] = [];
    const patches: unknown[] = [];
    const transitions: unknown[] = [];
    const existing = new Set<string>();
    const applier = new PlannerResultApplier({
      cardStore: {
        read: (id) => (existing.has(id) ? ({ id } as CardRecord) : null),
        create: (card) => {
          created.push(card);
          if (card.id) existing.add(card.id);
        },
        mutateCard: (id, changes, meta) => mutated.push({ id, changes, meta }),
      },
      now: () => '2026-01-01T00:00:00.000Z',
      transitionCard: async (id, action, input) => {
        transitions.push({ id, action, input });
      },
      updateCard: async (id, patch) => {
        patches.push({ id, patch });
      },
    });

    await applier.apply('goal-a', {
      status: 'continue',
      created_cards: [{ id: 'child-a', type: 'code', title: 'Child', description: 'Do it', status: 'backlog', depends_on: [], priority: 1 }],
      updated_cards: [{ id: 'child-a', title: 'Updated', status: 'blocked' }],
    });

    expect(created).toHaveLength(1);
    expect(mutated).toEqual([expect.objectContaining({ id: 'child-a', changes: { title: 'Updated' } })]);
    expect(transitions).toEqual([{ id: 'child-a', action: 'planner_set_status', input: { requestedStatus: 'blocked' } }]);
    expect(patches).toEqual([]);
  });

  it('commits planner-done lifecycle only for non-parent planning-only cards', async () => {
    const cards = new Map<string, CardRecord>([
      ['doc-a', baseCard({ id: 'doc-a', type: 'doc' })],
      ['goal-a', baseCard({ id: 'goal-a', type: 'goal' })],
    ]);
    const transitions: unknown[] = [];
    const patches: unknown[] = [];
    const applier = new PlannerResultApplier({
      cardStore: {
        read: (id) => cards.get(id) ?? null,
        create: () => undefined,
        mutateCard: () => undefined,
      },
      now: () => '2026-01-01T00:00:00.000Z',
      transitionCard: async (id, action, input) => {
        transitions.push({ id, action, input });
      },
      updateCard: async (id, patch) => {
        patches.push({ id, patch });
      },
    });

    await applier.apply('goal-a', {
      status: 'continue',
      summary: 'planned doc closure',
      created_cards: [],
      updated_cards: [{ id: 'doc-a', status: 'done' }, { id: 'goal-a', status: 'done' }],
    });

    expect(transitions).toEqual([
      { id: 'doc-a', action: 'complete', input: { summary: 'planned doc closure' } },
      { id: 'goal-a', action: 'planner_set_status', input: { requestedStatus: 'done' } },
    ]);
    expect(patches).toEqual([
      expect.objectContaining({
        id: 'doc-a',
        patch: expect.objectContaining({
          status: 'done',
          error: null,
          completed_at: '2026-01-01T00:00:00.000Z',
          result: expect.objectContaining({
            kind: 'planner_done',
            created_cards: [],
            updated_cards: ['doc-a', 'goal-a'],
            summary: 'planned doc closure',
            planning: expect.objectContaining({ status: 'done' }),
          }),
        }),
      }),
    ]);
  });
});

function baseCard(overrides: Partial<CardRecord> = {}): CardRecord {
  const lifecycle = overrides.lifecycle ?? ({ status: overrides.status ?? 'running', result: null, error: null, completed_at: null } as CardRecord['lifecycle']);
  return {
    id: overrides.id ?? 'card-a',
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'goal-a',
    depth: overrides.depth ?? 1,
    position: overrides.position ?? 0,
    title: overrides.title ?? 'Card',
    description: overrides.description ?? '',
    status: overrides.status ?? 'running',
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'planner',
    created_at: overrides.created_at ?? '2026-01-01T00:00:00.000Z',
    updated_at: overrides.updated_at ?? '2026-01-01T00:00:00.000Z',
    version_seq: overrides.version_seq ?? 1,
    depends_on: overrides.depends_on ?? [],
    blocks: overrides.blocks ?? [],
    related: overrides.related ?? [],
    acceptance: overrides.acceptance ?? '',
    lifecycle,
    artifacts: overrides.artifacts ?? [],
    attachments: overrides.attachments ?? [],
    retries: overrides.retries ?? 0,
  };
}

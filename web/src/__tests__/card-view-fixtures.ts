import { cardViewSchema } from '@saivage/schemas';
import type { CardRecord } from '../api/types';

type CardOverrides = Partial<Omit<CardRecord, 'id' | 'parent' | 'depth'>>;

function identityFor(id: string): { parent: string | null; depth: number } {
  if (id === 'project') return { parent: null, depth: 0 };
  const segments = id.slice('card-'.length).split('-');
  return {
    parent: segments.length === 1 ? 'project' : `card-${segments.slice(0, -1).join('-')}`,
    depth: segments.length,
  };
}

function lifecycleFor(status: CardRecord['status']): CardRecord['lifecycle'] {
  switch (status) {
    case 'done':
      return { status, result: { kind: 'done', summary: 'Done' }, error: null, completed_at: '2026-01-01T00:00:00.000Z' };
    case 'failed':
      return { status, result: { kind: 'failed', summary: 'Failed' }, error: 'Failed', completed_at: '2026-01-01T00:00:00.000Z' };
    case 'blocked':
      return { status, result: { kind: 'blocked', summary: 'Blocked' }, error: 'Blocked', completed_at: null };
    case 'cancelled':
      return { status, result: null, error: null, completed_at: '2026-01-01T00:00:00.000Z' };
    default:
      return { status, result: null, error: null, completed_at: null };
  }
}

export function cardView(id: string, overrides: CardOverrides = {}): CardRecord {
  const status = overrides.status ?? 'backlog';
  const lifecycle = overrides.lifecycle ?? lifecycleFor(status);
  const { parent, depth } = identityFor(id);
  return cardViewSchema.parse({
    id,
    type: id === 'project' ? 'project' : 'code',
    parent,
    depth,
    position: 0,
    children: [],
    title: id === 'project' ? 'Project' : 'Card',
    status,
    lifecycle,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'analyst',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    version_seq: 1,
    depends_on: [],
    related: [],
    pending_notifications: [],
    logical_path: id === 'project' ? null : '1',
    operator_summary: {
      lifecycleStatus: lifecycle.status,
      terminal: ['done', 'failed', 'cancelled'].includes(lifecycle.status),
      blocked: lifecycle.status === 'blocked',
      hasError: lifecycle.error !== null,
      error: lifecycle.error,
      completedAt: lifecycle.completed_at,
      stale: lifecycle.status === 'changed',
      actionCount: 0,
    },
    ...overrides,
  }) as CardRecord;
}

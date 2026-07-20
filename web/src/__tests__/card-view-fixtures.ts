import { operatorCardSchema } from '@saivage/schemas';
import type { CardRecord } from '../api/types';

type CardOverrides = Partial<Omit<CardRecord, 'id'>>;

function lifecycleFor(status: CardRecord['lifecycle']['status']): CardRecord['lifecycle'] {
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
  const lifecycle = overrides.lifecycle ?? lifecycleFor('backlog');
  return operatorCardSchema.parse({
    id,
    type: id === 'project' ? 'project' : 'code',
    children: [],
    title: id === 'project' ? 'Project' : 'Card',
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
    allowedActions: [],
    operator_summary: {
      blocked: lifecycle.status === 'blocked',
      hasError: lifecycle.error !== null,
      error: lifecycle.error,
      completedAt: lifecycle.completed_at,
      stale: lifecycle.status === 'changed',
    },
    ...overrides,
  });
}

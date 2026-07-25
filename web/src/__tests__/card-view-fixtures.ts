import { cardHistoryEntrySchema, cardHistoryHeaderSchema, cardRecordSchema, type CardHistoryEntry, type CardHistoryHeader, type CardRecord as RawCardRecord } from '@saivage/schemas';
import type { CardDetail, CardHierarchyRecord } from '../api/types';

function lifecycleFor(status: RawCardRecord['lifecycle']['status']): RawCardRecord['lifecycle'] {
  switch (status) {
    case 'done': return { status, result: workflowResult('DONE', 'approved', 'Done'), error: null, completed_at: '2026-01-01T00:00:00.000Z' };
    case 'failed': return { status, result: workflowResult('FAILED', 'failed', 'Failed'), error: 'Failed', completed_at: '2026-01-01T00:00:00.000Z' };
    case 'blocked': return { status, result: workflowResult('BLOCKED', 'blocked', 'Blocked'), error: 'Blocked', completed_at: null };
    default: return { status, result: null, error: null, completed_at: null };
  }
}

function workflowResult(terminal: 'DONE' | 'BLOCKED' | 'FAILED', outcome: string, summary: string) {
  return { kind: 'workflow-result' as const, terminal, agent_name: 'executor', node_id: 'execute', outcome, summary, records: [] };
}

export function rawCard(id: string, overrides: Partial<RawCardRecord> = {}): RawCardRecord {
  return cardRecordSchema.parse({
    id, type: id === 'project' ? 'project' : 'code', children: [], title: id === 'project' ? 'Project' : 'Card',
    lifecycle: lifecycleFor('backlog'), subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1,
    assigned_to: null, depends_on: [], related: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null,
    metadata: null, pending_notifications: [], ...overrides,
  });
}

export function cardView(id: string, overrides: Partial<CardDetail> = {}): CardDetail {
  const lifecycle = overrides.lifecycle ?? lifecycleFor('backlog');
  return { id, type: id === 'project' ? 'project' : 'code', title: id === 'project' ? 'Project' : 'Card', lifecycle, version_seq: 1, urgency: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', allowedActions: [], ...overrides };
}

export function hierarchyView(id: string, overrides: Partial<CardHierarchyRecord> = {}): CardHierarchyRecord { return { id, type: id === 'project' ? 'project' : 'code', title: id === 'project' ? 'Project' : 'Card', status: 'backlog', ...overrides }; }

export function historyHeader(overrides: Partial<CardHistoryHeader> & Pick<CardHistoryHeader, 'kind' | 'card_id' | 'version_seq'>): CardHistoryHeader {
  const provenance = overrides.kind === 'update' ? { changed_by_actor: 'planner', changed_by_surface: 'runtime' } : overrides.kind === 'delete' ? { changed_by_actor: 'analyst', changed_by_surface: 'runtime' } : { changed_by_actor: 'runtime', changed_by_surface: 'runtime' };
  return cardHistoryHeaderSchema.parse({ entry_id: '11111111-1111-4111-8111-111111111111', changed_at: '2026-01-01T00:00:01.000Z', change_reason: overrides.kind === 'update' ? 'planner edit_card' : null, changed_fields: ['title'], change_summary: 'title updated', ...provenance, ...overrides });
}

export function historyEntry(overrides: Partial<CardHistoryEntry> & Pick<CardHistoryEntry, 'kind' | 'card_id' | 'version_seq' | 'snapshot'>): CardHistoryEntry {
  const { snapshot, ...headerOverrides } = overrides;
  return cardHistoryEntrySchema.parse({ ...historyHeader(headerOverrides), ...headerOverrides, snapshot });
}

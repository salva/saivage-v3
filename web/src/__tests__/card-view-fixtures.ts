import type { CardDetail, CardHierarchyRecord, CardHistoryEntry } from '../api/types';

type HistoryCard = Extract<CardHistoryEntry['artifact'], { kind: 'card-version' }>['card'];

function lifecycleFor(status: HistoryCard['lifecycle']['status']): HistoryCard['lifecycle'] {
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

export function historyCard(id: string, overrides: Partial<HistoryCard> = {}): HistoryCard {
  return {
    id, type: id === 'project' ? 'project' : 'code', child_membership: [], active_child_order: [], title: id === 'project' ? 'Project' : 'Card',
    lifecycle: lifecycleFor('backlog'), subtype: null, priority: 0, urgency: 'normal', created_by: 'analyst',
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', version_seq: 1,
    assigned_to: null, depends_on: [], metrics: null, estimate: null, started_at: null, duration_ms: null,
    status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null,
    metadata: null, ...overrides,
  };
}

export function cardView(id: string, overrides: Partial<CardDetail> = {}): CardDetail {
  const lifecycle = overrides.lifecycle ?? lifecycleFor('backlog');
  return { id, type: id === 'project' ? 'project' : 'code', title: id === 'project' ? 'Project' : 'Card', lifecycle, version_seq: 1, urgency: 'normal', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', allowedActions: [], ...overrides };
}

export function hierarchyView(id: string, overrides: Partial<CardHierarchyRecord> = {}): CardHierarchyRecord { return { id, type: id === 'project' ? 'project' : 'code', title: id === 'project' ? 'Project' : 'Card', status: 'backlog', permitted_child_types: id === 'project' ? ['goal', 'architecture', 'code', 'test', 'doc', 'data', 'research', 'ops'] : [], ...overrides }; }

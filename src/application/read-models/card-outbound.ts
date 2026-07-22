import type { CardDiffEntry } from '../../cards/card-service.js';
import {
  cardHistoryEntrySchema,
  cardHistoryHeaderSchema,
  cardLifecycleStateSchema,
  cardNotificationSchema,
  cardRecordSchema,
  type CardHistoryEntry,
  type CardHistoryHeader,
  type CardRecord,
} from '../../schemas/index.js';
import {
  OperatorCardSchema,
  RuntimeCardRunsResponseSchema,
  type OperatorCard,
  type RuntimeCardRunsResponse,
} from '../../contracts/index.js';
import { redactTextForOutbound } from '../../redaction/text.js';

export function projectOperatorCard(card: OperatorCard): OperatorCard {
  const parsed = OperatorCardSchema.parse(card);
  const { allowedActions, operator_summary, ...record } = parsed;
  return OperatorCardSchema.parse({
    ...projectCardRecordForOutbound(record),
    allowedActions: [...allowedActions],
    operator_summary: {
      blocked: operator_summary.blocked,
      hasError: operator_summary.hasError,
      error: redactNullableText(operator_summary.error),
      completedAt: operator_summary.completedAt,
      stale: operator_summary.stale,
    },
  });
}

export function projectCardRecordForOutbound(card: CardRecord): CardRecord {
  const parsed = cardRecordSchema.parse(card);
  return cardRecordSchema.parse({
    id: parsed.id,
    type: parsed.type,
    children: [...parsed.children],
    title: redactTextForOutbound(parsed.title),
    lifecycle: projectLifecycle(parsed.lifecycle),
    subtype: parsed.subtype,
    tags: [...parsed.tags],
    priority: parsed.priority,
    urgency: parsed.urgency,
    created_by: parsed.created_by,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
    version_seq: parsed.version_seq,
    assigned_to: parsed.assigned_to,
    depends_on: [...parsed.depends_on],
    related: [...parsed.related],
    metrics: parsed.metrics,
    estimate: parsed.estimate,
    started_at: parsed.started_at,
    duration_ms: parsed.duration_ms,
    status_text: redactNullableText(parsed.status_text),
    status_text_updated_at: parsed.status_text_updated_at,
    status_text_author_session_id: parsed.status_text_author_session_id,
    latest_self_report: parsed.latest_self_report,
    metadata: parsed.metadata,
    pending_notifications: parsed.pending_notifications.map(projectNotification),
  });
}

export function projectCardHistory(value: CardHistoryHeader | CardHistoryEntry): CardHistoryHeader | CardHistoryEntry {
  if ('snapshot' in value) {
    const parsed = cardHistoryEntrySchema.parse(value);
    return cardHistoryEntrySchema.parse({
      ...projectHistoryCommon(parsed),
      kind: parsed.kind,
      changed_by_actor: parsed.changed_by_actor,
      changed_by_surface: parsed.changed_by_surface,
      snapshot: projectCardRecordForOutbound(parsed.snapshot),
    });
  }
  const parsed = cardHistoryHeaderSchema.parse(value);
  return cardHistoryHeaderSchema.parse({
    ...projectHistoryCommon(parsed),
    kind: parsed.kind,
    changed_by_actor: parsed.changed_by_actor,
    changed_by_surface: parsed.changed_by_surface,
  });
}

export function projectCardDiff(diff: CardDiffEntry[]): CardDiffEntry[] {
  return diff.map((entry) => ({
    field: entry.field,
    before: projectDiffValue(entry.field, entry.before),
    after: projectDiffValue(entry.field, entry.after),
  }));
}

export function projectRuntimeCardRuns(value: RuntimeCardRunsResponse): RuntimeCardRunsResponse {
  const parsed = RuntimeCardRunsResponseSchema.parse(value);
  return RuntimeCardRunsResponseSchema.parse({
    current_card_id: parsed.current_card_id,
    active_breadcrumb: parsed.active_breadcrumb.map((item) => ({
      card_id: item.card_id,
      card_type: item.card_type,
      title: redactTextForOutbound(item.title),
      ...(item.status_text !== undefined ? { status_text: redactTextForOutbound(item.status_text) } : {}),
    })),
    dormant_agents: parsed.dormant_agents.map((agent) => ({
      card_id: agent.card_id,
      agent_name:agent.agent_name,
      session_id: agent.session_id,
    })),
  });
}

function projectHistoryCommon(value: CardHistoryHeader | CardHistoryEntry) {
  return {
    entry_id: value.entry_id,
    card_id: value.card_id,
    version_seq: value.version_seq,
    changed_at: value.changed_at,
    change_reason: redactNullableText(value.change_reason),
    changed_fields: [...value.changed_fields],
    change_summary: redactTextForOutbound(value.change_summary),
  };
}

function projectLifecycle(value: CardRecord['lifecycle']): CardRecord['lifecycle'] {
  const lifecycle = cardLifecycleStateSchema.parse(value);
  switch (lifecycle.status) {
    case 'backlog':
    case 'running':
    case 'changed':
    case 'stopped':
    case 'cancelled':
      return { ...lifecycle };
    case 'done':
      return { ...lifecycle, result: projectTerminalResult(lifecycle.result) };
    case 'failed':
      return {
        ...lifecycle,
        result: projectTerminalResult(lifecycle.result),
        error: redactTextForOutbound(lifecycle.error),
      };
    case 'blocked':
      return {
        ...lifecycle,
        result: projectTerminalResult(lifecycle.result),
        error: redactTextForOutbound(lifecycle.error),
      };
  }
}
function projectTerminalResult<T extends import('../../schemas/index.js').CardResult>(result:T):T{return {...result,summary:redactTextForOutbound(result.summary)};}

function projectDiffValue(field: string, value: unknown): unknown {
  switch (field) {
    case 'title': return typeof value === 'string' ? redactTextForOutbound(value) : failDiffType(field);
    case 'status_text': return value === null ? null : typeof value === 'string' ? redactTextForOutbound(value) : failDiffType(field);
    case 'lifecycle': return projectLifecycle(cardLifecycleStateSchema.parse(value));
    case 'pending_notifications': return cardNotificationSchema.array().parse(value).map(projectNotification);
    case 'id':
    case 'type':
    case 'children':
    case 'subtype':
    case 'tags':
    case 'priority':
    case 'urgency':
    case 'created_by':
    case 'created_at':
    case 'updated_at':
    case 'version_seq':
    case 'assigned_to':
    case 'depends_on':
    case 'related':
    case 'metrics':
    case 'estimate':
    case 'started_at':
    case 'duration_ms':
    case 'status_text_updated_at':
    case 'status_text_author_session_id':
    case 'latest_self_report':
    case 'metadata':
      return structuredClone(value);
    default:
      throw new Error(`Unknown card diff field '${field}'.`);
  }
}

function projectNotification(notification: { id: string; content: string; created_at: string; source?: string }) {
  return {
    id: notification.id,
    content: redactTextForOutbound(notification.content),
    created_at: notification.created_at,
    ...(notification.source !== undefined ? { source: notification.source } : {}),
  };
}

function redactNullableText(value: string | null): string | null {
  return value === null ? null : redactTextForOutbound(value);
}

function failDiffType(field: string): never {
  throw new Error(`Card diff field '${field}' has an invalid value.`);
}

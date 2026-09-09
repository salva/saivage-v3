import type { CardDiffEntry } from '../../cards/card-service.js';
import {
  cardLifecycleStateSchema,
  cardRecordSchema,
  outboundCardRecordSchema,
  type OutboundCardRecord,
  type CardRecord,
} from '../../schemas/index.js';
import { redactTextForOutbound } from '../../redaction/text.js';

export function projectCardRecordForOutbound(card: CardRecord): OutboundCardRecord {
  const parsed = cardRecordSchema.parse(card);
  return outboundCardRecordSchema.parse({
    id: parsed.id,
    type: parsed.type,
    child_membership: [...parsed.child_membership],
    active_child_order: [...parsed.active_child_order],
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
  });
}

export function projectCardDiff(diff: CardDiffEntry[]): CardDiffEntry[] {
  return diff.filter((entry) => entry.field !== 'pending_notifications').map((entry) => ({
    field: entry.field,
    before: projectDiffValue(entry.field, entry.before),
    after: projectDiffValue(entry.field, entry.after),
  }));
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
    case 'id':
    case 'type':
    case 'child_membership':
    case 'active_child_order':
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

function redactNullableText(value: string | null): string | null {
  return value === null ? null : redactTextForOutbound(value);
}

function failDiffType(field: string): never {
  throw new Error(`Card diff field '${field}' has an invalid value.`);
}

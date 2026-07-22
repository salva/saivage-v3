import { basename } from 'node:path';
import type { CardService } from '../../cards/card-api.js';
import { cardHistoryEntrySchema, cardHistoryHeaderSchema, positiveSafeIntegerSchema, type CardHistoryEntry, type CardHistoryHeader, type CardRecord } from '../../schemas/index.js';
import { allowedOperatorCardActions } from '../../permissions/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import type {
  OperatorApiHandlerResult,
  OperatorApiQuery,
  OperatorApiResponse,
  OperatorCard,
  ServerAvailability,
} from '../../contracts/index.js';
import {
  CardChildrenResponseSchema,
  CardDetailResponseSchema,
  CardDiffResponseSchema,
  CardHistoryEntryResponseSchema,
  CardHistoryListResponseSchema,
  OperatorCardSchema,
} from '../../contracts/index.js';
import { toCardOperatorSummary } from './card-view.js';

export function toOperatorCard(card: CardRecord): OperatorCard {
  const actions = allowedOperatorCardActions(card.lifecycle.status);
  return {
    id: card.id, type: card.type, children: card.children, title: card.title, lifecycle: card.lifecycle,
    subtype: card.subtype, tags: card.tags, priority: card.priority, urgency: card.urgency, created_by: card.created_by,
    created_at: card.created_at, updated_at: card.updated_at, version_seq: card.version_seq, assigned_to: card.assigned_to,
    depends_on: card.depends_on, related: card.related, metrics: card.metrics, estimate: card.estimate,
    started_at: card.started_at, duration_ms: card.duration_ms, status_text: card.status_text,
    status_text_updated_at: card.status_text_updated_at, status_text_author_session_id: card.status_text_author_session_id,
    latest_self_report: card.latest_self_report, metadata: card.metadata, pending_notifications: card.pending_notifications,
    allowedActions: actions,
    operator_summary: toCardOperatorSummary(card),
  };
}

function invalidNumberBody(path: 'seq' | 'from' | 'to'): OperatorApiResponse<'cards.history.get', 400> {
  const subject = path === 'seq' ? 'History sequence' : `Diff ${path} pivot`;
  const message = `${subject} must be a positive safe integer`;
  return {
    error: 'ValidationError',
    message,
    issues: [{ path, message }],
  };
}

function historyHeader(entry: CardHistoryEntry): CardHistoryHeader {
  return cardHistoryHeaderSchema.parse({
    entry_id: entry.entry_id,
    kind: entry.kind,
    card_id: entry.card_id,
    version_seq: entry.version_seq,
    changed_at: entry.changed_at,
    changed_by_actor: entry.changed_by_actor,
    changed_by_surface: entry.changed_by_surface,
    change_reason: entry.change_reason,
    changed_fields: entry.changed_fields,
    change_summary: entry.change_summary,
  });
}

export class CardsReadModelService {
  constructor(private readonly projectRoot: string, private readonly store: CardService, private readonly runtime: Pick<RuntimeApi, 'getRuntimeState'>) {}

  getRuntimeState(serverAvailability?: ServerAvailability): OperatorApiHandlerResult<'runtime.getState'> {
    const projectId = basename(this.projectRoot);
    const identity = { projectRoot: this.projectRoot, projectId };
    const state = this.runtime.getRuntimeState();
    return { body: { ...identity, runtime: state, ...(serverAvailability ? { serverAvailability } : {}) } };
  }

  getChildren(id: string): OperatorApiHandlerResult<'cards.children'> {
    const result = this.store.getCardChildren(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const card = OperatorCardSchema.parse(redactForOutbound({ source: 'operator-card', value: toOperatorCard(result.value.parent) }));
    const children = result.value.activeChildren.map((child) => OperatorCardSchema.parse(redactForOutbound({ source: 'operator-card', value: toOperatorCard(child) })));
    return { body: CardChildrenResponseSchema.parse({ card, children }) };
  }

  getCard(id: string): OperatorApiHandlerResult<'cards.get'> {
    const result = this.store.getCardDetail(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const card = OperatorCardSchema.parse(redactForOutbound({ source: 'operator-card', value: toOperatorCard(result.value) }));
    return { body: CardDetailResponseSchema.parse({ card }) };
  }

  listHistory(id: string): OperatorApiHandlerResult<'cards.history.list'> {
    const result = this.store.listCardHistory(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const history = result.value.map((entry) => cardHistoryHeaderSchema.parse(redactForOutbound({ source: 'card-history', value: historyHeader(entry) })));
    return { body: CardHistoryListResponseSchema.parse({ history, total: history.length }) };
  }

  getHistoryEntry(id: string, versionSeq: number): OperatorApiHandlerResult<'cards.history.get'> {
    if (!positiveSafeIntegerSchema.safeParse(versionSeq).success) return { statusCode: 400, body: invalidNumberBody('seq') };
    const result = this.store.getCardHistoryEntry(id, versionSeq);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'history-entry-not-found') return { statusCode: 404, body: { error: 'Card history entry not found', cardId: id, version_seq: versionSeq } };
    const entry = cardHistoryEntrySchema.parse(redactForOutbound({ source: 'card-history', value: result.value }));
    return { body: CardHistoryEntryResponseSchema.parse({ entry }) };
  }

  diffCard(id: string, query: OperatorApiQuery<'cards.diff'>): OperatorApiHandlerResult<'cards.diff'> {
    for (const [path, pivot] of [['from', query.from], ['to', query.to]] as const) {
      if (pivot !== undefined && pivot !== 'last' && pivot !== 'current' && !positiveSafeIntegerSchema.safeParse(pivot).success) {
        return { statusCode: 400, body: invalidNumberBody(path) };
      }
    }
    const result = this.store.diffCardHistory(id, { fromSeq: query.from, toSeq: query.to });
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'invalid-pivots') return { statusCode: 400, body: { error: 'Invalid diff pivots', from: result.from, to: result.to } };
    if (result.kind === 'diff-source-not-found') return { statusCode: 404, body: { error: 'Card diff source not found', cardId: id, from: result.from, to: result.to, missing_version_seq: result.missingVersionSeq } };
    const diff = redactForOutbound({ source: 'card-diff', value: result.diff });
    return { body: CardDiffResponseSchema.parse({ diff, from: result.from, to: result.to, card_id: id }) };
  }
}

import { basename } from 'node:path';
import type { CardService } from '../../cards/card-api.js';
import { cardHistoryEntrySchema, cardHistoryHeaderSchema, positiveSafeIntegerSchema, type CardHistoryEntry, type CardHistoryHeader, type CardLifecycleState, type CardRecord } from '../../schemas/index.js';
import { allowedOperatorCardActions } from '../../permissions/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import type {
  OperatorApiHandlerResult,
  OperatorApiQuery,
  OperatorApiResponse,
  ServerAvailability,
} from '../../contracts/index.js';
import {
  CardDetailSchema,
  CardChildrenResponseSchema,
  CardDetailResponseSchema,
  CardDiffResponseSchema,
  CardHistoryEntryResponseSchema,
  CardHistoryListResponseSchema,
  CardRecordContentResponseSchema,
  CardRecordListResponseSchema,
  throwIfPublicationOutcomeUnknown,
} from '../../contracts/index.js';
import { AuthoredRecordDefinitionNotFoundError, AuthoredRecordNotFoundError } from '../../persistence/authored-record-files.js';
import type { CanonicalReadInstrumentation } from '../../persistence/growing-file.js';
import { redactTextForOutbound } from '../../redaction/text.js';

function projectLifecycle(lifecycle: CardLifecycleState): CardLifecycleState {
  switch (lifecycle.status) {
    case 'done': return { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) } };
    case 'failed': return { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) }, error: redactTextForOutbound(lifecycle.error) };
    case 'blocked': return { ...lifecycle, result: { ...lifecycle.result, summary: redactTextForOutbound(lifecycle.result.summary) }, error: redactTextForOutbound(lifecycle.error) };
    default: return { ...lifecycle };
  }
}

function detail(card: CardRecord) {
  return CardDetailSchema.parse({ id: card.id, title: redactTextForOutbound(card.title), type: card.type, lifecycle: projectLifecycle(card.lifecycle), version_seq: card.version_seq, urgency: card.urgency, created_at: card.created_at, updated_at: card.updated_at, allowedActions: allowedOperatorCardActions(card.lifecycle.status) });
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

  getChildren(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.children'> {
    const result = this.store.getCardChildren(id, instrumentation);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.value.parent.id !== id) throw new Error(`Hierarchy parent '${result.value.parent.id}' does not match requested card '${id}'.`);
    const hierarchy = (card: CardRecord) => ({ id: card.id, title: redactTextForOutbound(card.title), type: card.type, status: card.lifecycle.status });
    return { body: CardChildrenResponseSchema.parse({ parent: hierarchy(result.value.parent), children: result.value.activeChildren.map(hierarchy) }) };
  }

  getCard(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.get'> {
    const result = this.store.getCardDetail(id, instrumentation);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    return { body: CardDetailResponseSchema.parse({ card: detail(result.value) }) };
  }

  listRecords(id: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.records.list'> {
    const active = this.store.getCardDetail(id, instrumentation);
    if (active.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const records = this.store.recordReader.definitions(id).map(({ filename, writers, format, schema, bootstrap }) => ({ name: filename, writers: [...writers], format, schema: redactTextForOutbound(schema), bootstrap }));
    return { body: CardRecordListResponseSchema.parse({ card_id: id, records }) };
  }

  getRecord(id: string, name: string, instrumentation?: CanonicalReadInstrumentation): OperatorApiHandlerResult<'cards.records.get'> {
    const active = this.store.getCardDetail(id, instrumentation);
    if (active.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    let definition;
    try { definition = this.store.recordReader.definition(id, name); }
    catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof AuthoredRecordDefinitionNotFoundError) return { statusCode: 404, body: { error: 'Card record definition not found', cardId: id, name } };
      throw error;
    }
    try {
      const projection = this.store.readRecord(id, name, 'latest', instrumentation);
      if (projection.artifact.committed_at === null) throw new Error(`Closed record '${id}/${name}' has no committed timestamp.`);
      return { body: CardRecordContentResponseSchema.parse({ card_id: id, record: { name, version: projection.version, committed_at: projection.artifact.committed_at, content: redactTextForOutbound(projection.artifact.content) } }) };
    } catch (error) {
      throwIfPublicationOutcomeUnknown(error);
      if (error instanceof AuthoredRecordNotFoundError && !definition.bootstrap) return { statusCode: 404, body: { error: 'Card record not found', cardId: id, name } };
      throw error;
    }
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

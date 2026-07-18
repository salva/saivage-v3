import { basename } from 'node:path';
import type { CardService } from '../../cards/card-api.js';
import { positiveSafeIntegerSchema, type CardHistoryEntry, type CardRecord } from '../../schemas/index.js';
import { allowedActions } from '../../permissions/index.js';
import type { RuntimeApi } from '../../runtime/runtime-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { OperatorCard, ServerAvailability } from '../../contracts/index.js';
import { toCardOperatorSummary } from './card-view.js';

export type ReadModelResult<T> = { statusCode?: number; body: T };

export function toOperatorCard(card: CardRecord): OperatorCard {
  return { ...card, allowedActions: allowedActions('operator', card.lifecycle.status), operator_summary: toCardOperatorSummary(card) };
}

function redactValue<T>(value: T, source = 'cards-read-model'): T {
  return redactForOutbound(value, 'operator.api', { source }) as T;
}

function historyHeader(entry: CardHistoryEntry) {
  return {
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
  };
}

export class CardsReadModelService {
  constructor(private readonly projectRoot: string, private readonly store: CardService, private readonly runtime: Pick<RuntimeApi, 'getRuntimeState'>) {}

  getRuntimeState(serverAvailability?: ServerAvailability) {
    const projectId = basename(this.projectRoot);
    const identity = { projectRoot: this.projectRoot, projectId };
    const state = this.runtime.getRuntimeState();
    return { body: { ...identity, runtime: state, ...(serverAvailability ? { serverAvailability } : {}) } };
  }

  getChildren(id: string): ReadModelResult<unknown> {
    const result = this.store.getCardChildren(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    return { body: { card: toOperatorCard(result.value.parent), children: result.value.activeChildren.map(toOperatorCard) } };
  }

  getCard(id: string): ReadModelResult<unknown> {
    const result = this.store.getCardDetail(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    return { body: { card: toOperatorCard(result.value) } };
  }

  listHistory(id: string): ReadModelResult<unknown> {
    const result = this.store.listCardHistory(id);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const history = result.value.map((entry) => redactValue(historyHeader(entry)));
    return { body: { history, total: history.length } };
  }

  getHistoryEntry(id: string, versionSeq: number): ReadModelResult<unknown> {
    if (!positiveSafeIntegerSchema.safeParse(versionSeq).success) return { statusCode: 400, body: { error: 'Invalid version sequence', version_seq: versionSeq } };
    const result = this.store.getCardHistoryEntry(id, versionSeq);
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'history-entry-not-found') return { statusCode: 404, body: { error: 'Card history entry not found', cardId: id, version_seq: versionSeq } };
    return { body: { entry: redactValue(result.value) } };
  }

  diffCard(id: string, query: { from?: number | 'last' | 'current'; to?: number | 'last' | 'current' }): ReadModelResult<unknown> {
    for (const pivot of [query.from, query.to]) {
      if (pivot !== undefined && pivot !== 'last' && pivot !== 'current' && !positiveSafeIntegerSchema.safeParse(pivot).success) return { statusCode: 400, body: { error: 'Invalid diff pivot' } };
    }
    const result = this.store.diffCardHistory(id, { fromSeq: query.from, toSeq: query.to });
    if (result.kind === 'card-not-found') return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    if (result.kind === 'invalid-pivots') return { statusCode: 400, body: { error: 'Invalid diff pivots', from: result.from, to: result.to } };
    if (result.kind === 'diff-source-not-found') return { statusCode: 404, body: { error: 'Card diff source not found', cardId: id, from: result.from, to: result.to, missing_version_seq: result.missingVersionSeq } };
    return { body: { diff: redactValue(result.diff), from: result.from, to: result.to, card_id: id } };
  }
}

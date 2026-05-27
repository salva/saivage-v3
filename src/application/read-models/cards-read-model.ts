import { basename } from 'node:path';
import { CardStore } from '../../cards/store-api.js';
import type { CardHistoryEntry, CardRecord } from '../../schemas/index.js';
import { allowedActions } from '../../permissions/index.js';
import { readRuntimeState } from '../../runtime/state-api.js';
import { redactForOutbound } from '../../redaction/index.js';
import type { ServerAvailability } from '../../contracts/index.js';

export type ReadModelResult<T> = { statusCode?: number; body: T };

function withOperatorAllowedActions(card: CardRecord): CardRecord {
  return { ...card, allowedActions: allowedActions('operator', card.status) };
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
  private readonly store: CardStore;
  constructor(private readonly projectRoot: string) { this.store = new CardStore(projectRoot); }

  getRuntimeState(serverAvailability?: ServerAvailability) {
    const projectId = basename(this.projectRoot);
    const identity = { projectRoot: this.projectRoot, projectId };
    const state = readRuntimeState(this.projectRoot);
    if (!state) return { body: { ...identity, runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, ...(serverAvailability ? { serverAvailability } : {}) } };
    const cards = this.store.list();
    const byStatus: Record<string, number> = {};
    const byType: Record<string, number> = {};
    for (const card of cards) { byStatus[card.status] = (byStatus[card.status] || 0) + 1; byType[card.type] = (byType[card.type] || 0) + 1; }
    return { body: { ...identity, runtime: state, cardIndex: { total: cards.length, byStatus, byType }, ...(serverAvailability ? { serverAvailability } : {}) } };
  }

  listCards() {
    const cards = this.store.list().map(withOperatorAllowedActions);
    return { body: { cards, total: cards.length } };
  }

  getCard(id: string): ReadModelResult<unknown> {
    const card = this.store.read(id);
    if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    return { body: { card: withOperatorAllowedActions(card), children: this.store.listChildren(id).map((childId) => this.store.read(childId)).filter((c): c is CardRecord => c !== null).map(withOperatorAllowedActions), ancestorIds: this.store.getAncestors(id) } };
  }

  listHistory(id: string): ReadModelResult<unknown> {
    const card = this.store.read(id);
    if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const history = this.store.listCardHistory(id).map((entry) => redactValue(historyHeader(entry)));
    return { body: { history, total: history.length } };
  }

  getHistoryEntry(id: string, seqRaw: string): ReadModelResult<unknown> {
    const card = this.store.read(id);
    if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const seq = Number.parseInt(seqRaw, 10);
    if (!Number.isInteger(seq) || seq <= 0) return { statusCode: 400, body: { error: 'Invalid version sequence', version_seq: seqRaw } };
    const entry = this.store.listCardHistory(id).find((candidate) => candidate.version_seq === seq);
    if (!entry) return { statusCode: 404, body: { error: 'Card history entry not found', cardId: id, version_seq: seq } };
    return { body: { entry: redactValue(entry) } };
  }

  diffCard(id: string, query: { from?: string; to?: string }): ReadModelResult<unknown> {
    const card = this.store.read(id);
    if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
    const latest = card.version_seq;
    const resolve = (raw: string | undefined, fallback: number): number => {
      if (raw === undefined) return fallback;
      if (raw === 'last' || raw === 'current') return latest;
      return Number.parseInt(raw, 10);
    };
    const to = resolve(query.to, latest);
    const from = resolve(query.from, Math.max(1, to - 1));
    if (from <= 0 || to <= 0 || from > to) return { statusCode: 400, body: { error: 'Invalid diff pivots', from, to } };
    try { return { body: { diff: redactValue(this.store.diffCard(id, from, to)), from, to, card_id: id } }; }
    catch (err) { const message = err instanceof Error ? err.message : String(err); return { statusCode: message.includes('not found') || message.includes('has no version') ? 404 : 500, body: { error: message.includes('not found') || message.includes('has no version') ? 'Card diff source not found' : 'Failed to diff card', message } }; }
  }
}

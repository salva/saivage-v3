import type { FastifyInstance } from 'fastify';
import { basename } from 'node:path';
import { CardStore } from '../../cards/index.js';
import type { CardRecord, CardHistoryEntry } from '../../schemas/index.js';
import { operatorApiContracts } from '../../contracts/index.js';
import { allowedActions } from '../../permissions/index.js';
import { readRuntimeState } from '../../runtime/index.js';
import type { ActiveRuntime } from '../../runtime/index.js';
import { buildServerAvailability } from '../availability.js';
import { ContractRuntime, type ContractHandler } from '../contract-runtime.js';
import { redactForOutbound } from '../../redaction/index.js';

function withOperatorAllowedActions(card: CardRecord): CardRecord {
  return { ...card, allowedActions: allowedActions('operator', card.status) };
}


function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'operator-contracts.cards' }) as T;
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

export function registerOperatorContractRoutes(options: {
  fastify: FastifyInstance;
  projectRoot: string;
  activeRuntime?: ActiveRuntime;
  activeRuntimeProvider?: () => ActiveRuntime | undefined;
  serverAvailabilityProvider?: () => ReturnType<typeof buildServerAvailability>;
}): void {
  const { fastify, projectRoot } = options;
  const projectId = basename(projectRoot);
  const runtime = new ContractRuntime();
  const store = new CardStore(projectRoot);

  const handlers: Partial<Record<keyof typeof operatorApiContracts, ContractHandler>> = {
    'health.liveness': () => ({ body: { status: 'ok', version: '0.1.0', project: 'saivage-v3' } }),
    'health.readiness': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      return { statusCode: 200, body: { status: 'ready', ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'runtime.getState': () => {
      const serverAvailability = options.serverAvailabilityProvider?.();
      const state = readRuntimeState(projectRoot);
      const identity = { projectRoot, projectId };
      if (!state) return { body: { ...identity, runtime: null, cardIndex: { total: 0, byStatus: {}, byType: {} }, ...(serverAvailability ? { serverAvailability } : {}) } };
      const cards = store.list();
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const card of cards) { byStatus[card.status] = (byStatus[card.status] || 0) + 1; byType[card.type] = (byType[card.type] || 0) + 1; }
      return { body: { ...identity, runtime: state, cardIndex: { total: cards.length, byStatus, byType }, ...(serverAvailability ? { serverAvailability } : {}) } };
    },
    'cards.list': () => { const cards = store.list().map(withOperatorAllowedActions); return { body: { cards, total: cards.length } }; },
    'cards.get': ({ params }) => { const id = (params as unknown as { id: string }).id; const card = store.read(id); if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } }; // children are emitted in persisted position order (S03).
      return { body: { card: withOperatorAllowedActions(card), children: store.listChildren(id).map((childId) => store.read(childId)).filter((c): c is CardRecord => c !== null).map(withOperatorAllowedActions), ancestorIds: store.getAncestors(id) } }; },

    'cards.history.list': ({ params }) => {
      const id = (params as unknown as { id: string }).id;
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const history = store.listCardHistory(id).map((entry) => redactValue(historyHeader(entry)));
      return { body: { history, total: history.length } };
    },
    'cards.history.get': ({ params }) => {
      const { id, seq: seqRaw } = params as unknown as { id: string; seq: string };
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const seq = Number.parseInt(seqRaw, 10);
      if (!Number.isInteger(seq) || seq <= 0) return { statusCode: 400, body: { error: 'Invalid version sequence', version_seq: seqRaw } };
      const entry = store.listCardHistory(id).find((candidate) => candidate.version_seq === seq);
      if (!entry) return { statusCode: 404, body: { error: 'Card history entry not found', cardId: id, version_seq: seq } };
      return { body: { entry: redactValue(entry) } };
    },
    'cards.diff': ({ params, query }) => {
      const id = (params as unknown as { id: string }).id;
      const q = query as unknown as { from?: string; to?: string };
      const card = store.read(id);
      if (!card) return { statusCode: 404, body: { error: 'Card not found', cardId: id } };
      const latest = card.version_seq;
      const resolve = (raw: string | undefined, fallback: number): number => {
        if (raw === undefined) return fallback;
        if (raw === 'last' || raw === 'current') return latest;
        return Number.parseInt(raw, 10);
      };
      const to = resolve(q.to, latest);
      const from = resolve(q.from, Math.max(1, to - 1));
      if (from <= 0 || to <= 0 || from > to) return { statusCode: 400, body: { error: 'Invalid diff pivots', from, to } };
      try { return { body: { diff: redactValue(store.diffCard(id, from, to)), from, to, card_id: id } }; }
      catch (err) { const message = err instanceof Error ? err.message : String(err); return { statusCode: message.includes('not found') || message.includes('has no version') ? 404 : 500, body: { error: message.includes('not found') || message.includes('has no version') ? 'Card diff source not found' : 'Failed to diff card', message } }; }
    },
  };

  runtime.mount(fastify, operatorApiContracts, handlers);
}

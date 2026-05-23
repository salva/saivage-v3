import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CardStore } from '../../utils/card-store.js';
import type { CardRecord, CardStatus, CardType, CardHistoryEntry } from '../../schemas/types.js';
import { runMutatingRoute } from './runtime-config-notes.js';
import { operatorApiContracts } from '../../contracts/operator-api.js';
import { parseContractRequest, validateContractSuccess } from '../contract-route.js';
import { redactForOutbound } from '../../redaction/index.js';
import { allowedActions } from '../../permissions/index.js';

const TRACKED_UPDATE_FIELDS = new Set(['title','description','acceptance','depends_on','related','estimate','parent','assigned_to','type','subtype','instructions_file','tags','priority','urgency']);

function validatePriority(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100) {
    throw new Error('priority must be an integer from 0 to 100');
  }
  return value;
}

function redactValue<T>(value: T): T {
  return redactForOutbound(value, 'operator.api', { source: 'cards.route' }) as T;
}

function withOperatorAllowedActions(card: CardRecord): CardRecord {
  return { ...card, allowedActions: allowedActions('operator', card.status) };
}

function historyHeader(entry: CardHistoryEntry) {
  return {
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

export function registerCardRoutes(fastify: FastifyInstance, projectRoot: string): void {
  const store = new CardStore(projectRoot);
  const inputDefaults: Omit<CardRecord, 'id' | 'created_at' | 'updated_at' | 'version_seq'> = { type: 'code', parent: null, depth: 0, title: '', description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'user', assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0 };

  fastify.get('/api/cards', async (_request, reply) => {
    const cards = store.list().map(withOperatorAllowedActions);
    const payload = { cards, total: cards.length };
    return reply.send(validateContractSuccess(operatorApiContracts['cards.list'], payload));
  });
  fastify.get('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseContractRequest(operatorApiContracts['cards.get'], request);
    if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body);
    const params = parsed.params;
    const card = store.read(params.id);
    if (!card) return reply.status(404).send({ error: 'Card not found', cardId: params.id });
    const payload = { card: withOperatorAllowedActions(card), children: store.listChildren(params.id).map((childId) => store.read(childId)).filter((c): c is CardRecord => c !== null).map(withOperatorAllowedActions), ancestorIds: store.getAncestors(params.id) };
    return reply.send(validateContractSuccess(operatorApiContracts['cards.get'], payload));
  });
  fastify.get('/api/cards/:id/history', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const card = store.read(params.id);
      if (!card) return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      const history = store.listCardHistory(params.id).map((entry) => redactValue(historyHeader(entry)));
      return reply.send({ history, total: history.length });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to list card history', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.get('/api/cards/:id/history/:seq', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string; seq: string };
      const card = store.read(params.id);
      if (!card) return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      const seq = Number.parseInt(params.seq, 10);
      if (!Number.isInteger(seq) || seq <= 0) return reply.status(400).send({ error: 'Invalid version sequence', version_seq: params.seq });
      const entry = store.listCardHistory(params.id).find((candidate) => candidate.version_seq === seq);
      if (!entry) return reply.status(404).send({ error: 'Card history entry not found', cardId: params.id, version_seq: seq });
      return reply.send({ entry: redactValue(entry) });
    } catch (err) {
      return reply.status(500).send({ error: 'Failed to get card history entry', message: err instanceof Error ? err.message : String(err) });
    }
  });
  fastify.get('/api/cards/:id/diff', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const query = request.query as { from?: string; to?: string };
      const card = store.read(params.id);
      if (!card) return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      const from = Number.parseInt(String(query.from ?? ''), 10);
      const to = Number.parseInt(String(query.to ?? ''), 10);
      if (!Number.isInteger(from) || from <= 0 || !Number.isInteger(to) || to <= 0) return reply.status(400).send({ error: 'from and to query parameters are required positive integers' });
      const diff = redactValue(store.diffCard(params.id, from, to));
      return reply.send({ diff, from, to, card_id: params.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found') || message.includes('has no version')) return reply.status(404).send({ error: 'Card diff source not found', message });
      return reply.status(500).send({ error: 'Failed to diff card', message });
    }
  });

  fastify.post('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseContractRequest(operatorApiContracts['cards.create'], request);
    if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body);
    const body = (parsed.body ?? {}) as Record<string, unknown>;
    return runMutatingRoute({
    request,
    reply,
    projectRoot,
    action: 'card.create',
    safety_class: 'low',
    target_kind: 'card',
    target_id: null,
    mutate: async () => {
      try {
        const priority = validatePriority(body.priority);
        const card = store.create({ ...inputDefaults, type: (body.type as CardType) || inputDefaults.type, parent: (body.parent as string | null) ?? inputDefaults.parent, title: (body.title as string) || inputDefaults.title, description: (body.description as string) || inputDefaults.description, status: (body.status as CardStatus) || inputDefaults.status, tags: (body.tags as string[]) ?? inputDefaults.tags, priority: priority ?? inputDefaults.priority, urgency: (body.urgency as CardRecord['urgency']) || inputDefaults.urgency, created_by: (body.created_by as CardRecord['created_by']) || inputDefaults.created_by, depends_on: (body.depends_on as string[]) ?? inputDefaults.depends_on, related: (body.related as string[]) ?? inputDefaults.related, acceptance: (body.acceptance as string) || inputDefaults.acceptance, result: (body.result as Record<string, unknown>) ?? inputDefaults.result, metrics: (body.metrics as Record<string, string | number | boolean | null>) ?? inputDefaults.metrics, estimate: (body.estimate as string) ?? inputDefaults.estimate, error: (body.error as string) ?? inputDefaults.error, retries: (body.retries as number) ?? inputDefaults.retries, subtype: (body.subtype as string) ?? inputDefaults.subtype, assigned_to: (body.assigned_to as string) ?? inputDefaults.assigned_to, instructions_file: (body.instructions_file as string) ?? inputDefaults.instructions_file });
        return { ok: true, statusCode: 201, body: validateContractSuccess(operatorApiContracts['cards.create'], { card: withOperatorAllowedActions(card) }), outcomeSummary: 'card created' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, statusCode: 400, error: message, body: { error: 'Card creation failed', message }, outcomeSummary: message };
      }
    },
  });
  });

  fastify.patch('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = parseContractRequest(operatorApiContracts['cards.update'], request);
    if (!parsed.ok) return reply.status(parsed.statusCode).send(parsed.body);
    const params = parsed.params;
    const body = (parsed.body ?? {}) as Record<string, unknown>;
    const allowedFields = new Set(['title','description','status','tags','priority','urgency','acceptance','result','metrics','depends_on','related','estimate','error','retries','parent','assigned_to','type','subtype','instructions_file']);
    const changes: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) if (allowedFields.has(key)) changes[key] = value;
    const tracked = Object.keys(changes).some((field) => TRACKED_UPDATE_FIELDS.has(field));
    return runMutatingRoute({
      request,
      reply,
      projectRoot,
      action: 'card.update',
      safety_class: tracked ? 'high' : 'low',
      target_kind: 'card',
      target_id: params.id,
      mutate: async () => {
        try {
          if (Object.keys(changes).length === 0) return { ok: false, statusCode: 400, error: 'No valid fields to update', body: { error: 'No valid fields to update' }, outcomeSummary: 'no valid fields to update' };
          const card = tracked ? store.mutateCard(params.id, changes as Partial<CardRecord>, { actor: 'user', surface: 'rest', reason: 'REST card update' }) : store.update(params.id, changes as Partial<CardRecord>);
          return { ok: true, body: validateContractSuccess(operatorApiContracts['cards.update'], { card: withOperatorAllowedActions(card) }), outcomeSummary: 'card updated' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('not found')) return { ok: false, statusCode: 404, error: message, body: { error: 'Card not found' }, outcomeSummary: message };
          return { ok: false, statusCode: 400, error: message, body: { error: 'Card update failed', message }, outcomeSummary: message };
        }
      },
    });
  });

  fastify.delete('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string };
    return runMutatingRoute({
      request,
      reply,
      projectRoot,
      action: 'card.delete',
      safety_class: 'destructive',
      target_kind: 'card',
      target_id: params.id,
      mutate: async () => {
        try {
          store.delete(params.id);
          return { ok: true, statusCode: 204, body: undefined, outcomeSummary: 'card deleted' };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (message.includes('not found')) return { ok: false, statusCode: 404, error: message, body: { error: 'Card not found' }, outcomeSummary: message };
          return { ok: false, statusCode: 400, error: message, body: { error: 'Card deletion failed', message }, outcomeSummary: message };
        }
      },
    });
  });
}

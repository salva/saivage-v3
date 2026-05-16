import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CardStore } from '../../utils/card-store.js';
import type { CardRecord, CardStatus, CardType } from '../../schemas/types.js';
import { runMutatingRoute } from './runtime-config-notes.js';

const TRACKED_UPDATE_FIELDS = new Set(['title','description','acceptance','depends_on','related','estimate','parent','assigned_to','type','subtype','instructions_file','tags','priority','urgency']);

function createPreview(body: Record<string, unknown>) {
  return {
    type: 'card.create',
    summary: `Create card '${String(body.title ?? '') || '(untitled)'}'.`,
    affectedCards: [],
    affectedProcesses: [],
    warnings: [],
  };
}

function updatePreview(id: string, changes: Record<string, unknown>) {
  return {
    type: 'card.update',
    summary: `Update card '${id}' (${Object.keys(changes).join(', ') || 'no fields'}).`,
    affectedCards: [{ id, title: '(pending)', type: 'unknown', status: 'unknown' }],
    affectedProcesses: [],
    warnings: [],
  };
}

function deletePreview(id: string) {
  return {
    type: 'card.delete',
    summary: `Delete card '${id}'.`,
    affectedCards: [{ id, title: '(pending)', type: 'unknown', status: 'unknown' }],
    affectedProcesses: [],
    warnings: ['This permanently deletes the card and its descendants.'],
  };
}

export function registerCardRoutes(fastify: FastifyInstance, projectRoot: string): void {
  const store = new CardStore(projectRoot);
  const inputDefaults: Omit<CardRecord, 'id' | 'created_at' | 'updated_at' | 'version_seq'> = { type: 'code', parent: null, depth: 0, title: '', description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'user', assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, retries: 0 };

  fastify.get('/api/cards', async (_request, reply) => reply.send({ cards: store.list(), total: store.list().length }));
  fastify.get('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => { const params = request.params as { id: string }; const card = store.read(params.id); if (!card) return reply.status(404).send({ error: 'Card not found', cardId: params.id }); return reply.send({ card, children: store.listChildren(params.id).map((childId) => store.read(childId)).filter((c): c is CardRecord => c !== null), ancestorIds: store.getAncestors(params.id) }); });

  fastify.post('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => runMutatingRoute({
    request,
    reply,
    projectRoot,
    action: 'card.create',
    safety_class: 'low',
    target_kind: 'card',
    target_id: null,
    preview: createPreview((request.body as Record<string, unknown>) ?? {}),
    mutate: async () => {
      try {
        const body = request.body as Record<string, unknown>;
        const card = store.create({ ...inputDefaults, type: (body.type as CardType) || inputDefaults.type, parent: (body.parent as string | null) ?? inputDefaults.parent, title: (body.title as string) || inputDefaults.title, description: (body.description as string) || inputDefaults.description, status: (body.status as CardStatus) || inputDefaults.status, tags: (body.tags as string[]) ?? inputDefaults.tags, priority: (body.priority as number) ?? inputDefaults.priority, urgency: (body.urgency as CardRecord['urgency']) || inputDefaults.urgency, created_by: (body.created_by as CardRecord['created_by']) || inputDefaults.created_by, depends_on: (body.depends_on as string[]) ?? inputDefaults.depends_on, related: (body.related as string[]) ?? inputDefaults.related, acceptance: (body.acceptance as string) || inputDefaults.acceptance, result: (body.result as Record<string, unknown>) ?? inputDefaults.result, metrics: (body.metrics as Record<string, string | number | boolean | null>) ?? inputDefaults.metrics, estimate: (body.estimate as string) ?? inputDefaults.estimate, error: (body.error as string) ?? inputDefaults.error, retries: (body.retries as number) ?? inputDefaults.retries, subtype: (body.subtype as string) ?? inputDefaults.subtype, assigned_to: (body.assigned_to as string) ?? inputDefaults.assigned_to, instructions_file: (body.instructions_file as string) ?? inputDefaults.instructions_file });
        return { ok: true, statusCode: 201, body: { card }, outcomeSummary: 'card created' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, statusCode: 400, error: message, body: { error: 'Card creation failed', message }, outcomeSummary: message };
      }
    },
  }));

  fastify.patch('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { id: string };
    const body = request.body as Record<string, unknown>;
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
      preview: updatePreview(params.id, changes),
      mutate: async () => {
        try {
          if (Object.keys(changes).length === 0) return { ok: false, statusCode: 400, error: 'No valid fields to update', body: { error: 'No valid fields to update' }, outcomeSummary: 'no valid fields to update' };
          const card = tracked ? store.mutateCard(params.id, changes as Partial<CardRecord>, { actor: 'user', surface: 'rest', reason: 'REST card update' }) : store.update(params.id, changes as Partial<CardRecord>);
          return { ok: true, body: { card }, outcomeSummary: 'card updated' };
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
      preview: deletePreview(params.id),
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

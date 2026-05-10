import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { CardStore } from '../../utils/card-store.js';
import type { CardRecord, CardStatus, CardType, NoteRecord } from '../../schemas/types.js';
import { getNotes } from '../../utils/notes.js';

function saivageDir(projectRoot: string): string {
  return `${projectRoot}/.saivage`;
}

function enrichCardWithNotes(
  store: CardStore,
  projectRoot: string,
  card: CardRecord,
): CardRecord & { notes: NoteRecord[] } {
  const notes = getNotes(saivageDir(projectRoot), card.id);
  return { ...card, notes };
}

export function registerCardRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  const store = new CardStore(projectRoot);

  const inputDefaults: Omit<CardRecord, 'id' | 'created_at' | 'updated_at'> = {
    type: 'code',
    parent: null,
    depth: 0,
    title: '',
    description: '',
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'user',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    result: null,
    metrics: null,
    artifacts: [],
    attachments: [],
    estimate: null,
    started_at: null,
    completed_at: null,
    duration_ms: null,
    error: null,
    retries: 0,
    assigned_to: null,
  };

  fastify.get('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as Record<string, string | undefined>;
      let cards = store.list();

      if (query.status) cards = cards.filter((c) => c.status === query.status);
      if (query.type) cards = cards.filter((c) => c.type === query.type);
      if (query.parent) cards = cards.filter((c) => c.parent === query.parent);
      if (query.tag) cards = cards.filter((c) => c.tags.includes(query.tag!));

      const enriched = cards.map((c) => enrichCardWithNotes(store, projectRoot, c));
      return reply.send({ cards: enriched, total: enriched.length });
    } catch (err) {
      request.log.error(err, 'Failed to list cards');
      return reply.status(500).send({
        error: 'Failed to list cards',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const card = store.read(params.id);
      if (!card) {
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const children = store.listChildren(params.id)
        .map((childId) => store.read(childId))
        .filter((c): c is CardRecord => c !== null);

      return reply.send({
        card: enrichCardWithNotes(store, projectRoot, card),
        children,
        ancestorIds: store.getAncestors(params.id),
      });
    } catch (err) {
      request.log.error(err, 'Failed to read card');
      return reply.status(500).send({
        error: 'Failed to read card',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/cards', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as Record<string, unknown>;
      const card = store.create({
        ...inputDefaults,
        type: (body.type as CardType) || inputDefaults.type,
        parent: (body.parent as string | null) ?? inputDefaults.parent,
        title: (body.title as string) || inputDefaults.title,
        description: (body.description as string) || inputDefaults.description,
        status: (body.status as CardStatus) || inputDefaults.status,
        tags: (body.tags as string[]) ?? inputDefaults.tags,
        priority: (body.priority as number) ?? inputDefaults.priority,
        urgency: (body.urgency as CardRecord['urgency']) || inputDefaults.urgency,
        created_by: (body.created_by as CardRecord['created_by']) || inputDefaults.created_by,
        depends_on: (body.depends_on as string[]) ?? inputDefaults.depends_on,
        related: (body.related as string[]) ?? inputDefaults.related,
        acceptance: (body.acceptance as string) || inputDefaults.acceptance,
        result: (body.result as Record<string, unknown>) ?? inputDefaults.result,
        metrics: (body.metrics as Record<string, string | number | boolean | null>) ?? inputDefaults.metrics,
        estimate: (body.estimate as string) ?? inputDefaults.estimate,
        error: (body.error as string) ?? inputDefaults.error,
        retries: (body.retries as number) ?? inputDefaults.retries,
        subtype: (body.subtype as string) ?? inputDefaults.subtype,
        assigned_to: (body.assigned_to as string) ?? inputDefaults.assigned_to,
      });
      return reply.status(201).send({ card: enrichCardWithNotes(store, projectRoot, card) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to create card');
      const clientError = message.includes('validation') || message.includes('Cannot create') || message.includes('Plan cards')
        || message.includes('not found') || message.includes('cycle');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card creation failed' : 'Failed to create card',
        message,
      });
    }
  });

  fastify.patch('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const body = request.body as Record<string, unknown>;

      const allowedFields = new Set([
        'title', 'description', 'status', 'tags', 'priority',
        'urgency', 'acceptance', 'result', 'metrics', 'depends_on',
        'related', 'estimate', 'error', 'retries', 'parent',
        'assigned_to', 'type', 'subtype',
      ]);

      const changes: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(body)) {
        if (allowedFields.has(key)) changes[key] = value;
      }

      if (Object.keys(changes).length === 0) {
        return reply.status(400).send({ error: 'No valid fields to update' });
      }

      const card = store.update(params.id, changes as Partial<CardRecord>);
      return reply.send({ card: enrichCardWithNotes(store, projectRoot, card) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to update card');

      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const clientError = message.includes('validation') || message.includes('Cannot') || message.includes('cycle');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card update failed' : 'Failed to update card',
        message,
      });
    }
  });

  fastify.delete('/api/cards/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      store.delete(params.id);
      return reply.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      request.log.error(err, 'Failed to delete card');

      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Card not found', cardId: params.id });
      }

      const clientError = message.includes('Cannot delete') || message.includes('children');
      return reply.status(clientError ? 400 : 500).send({
        error: clientError ? 'Card deletion failed' : 'Failed to delete card',
        message,
      });
    }
  });
}

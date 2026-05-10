import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState, updateRuntimeState } from '../../utils/runtime-state.js';
import { loadConfig, type ProviderEntry } from '../../agents/config-schema.js';
import { getUnhandledNotesQueue, markNoteHandled, deleteNote, getNotes } from '../../utils/notes.js';
import { redactSecrets } from '../../utils/file-access-security.js';
import { CardStore } from '../../utils/card-store.js';

// ── Helpers ───────────────────────────────────────────────────

function saivageDir(projectRoot: string): string {
  return `${projectRoot}/.saivage`;
}

function findCardForNote(
  projectRoot: string,
  noteId: string,
): string | null {
  const queue = getUnhandledNotesQueue(saivageDir(projectRoot));
  const entry = queue.find((e: { note_id: string; card_id: string }) => e.note_id === noteId);
  return entry ? entry.card_id : null;
}

// ── Route Registration ────────────────────────────────────────

export function registerRuntimeConfigNotesRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  const store = new CardStore(projectRoot);

  // ═══════════════════════════════════════════════════════════
  // Runtime endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/state', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const state = readRuntimeState(projectRoot);
      if (!state) {
        return reply.send({
          runtime: null,
          cardIndex: { total: 0, byStatus: {}, byType: {} },
        });
      }

      const cards = store.list();
      const byStatus: Record<string, number> = {};
      const byType: Record<string, number> = {};
      for (const card of cards) {
        byStatus[card.status] = (byStatus[card.status] || 0) + 1;
        byType[card.type] = (byType[card.type] || 0) + 1;
      }

      return reply.send({
        runtime: state,
        cardIndex: {
          total: cards.length,
          byStatus,
          byType,
        },
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read runtime state',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/runtime/pause', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      updateRuntimeState(projectRoot, {
        status: 'paused',
        paused: true,
        paused_at: new Date().toISOString(),
      });
      return reply.send({ status: 'paused' });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to pause runtime',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/runtime/resume', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      updateRuntimeState(projectRoot, {
        status: 'idle',
        paused: false,
        paused_at: null,
      });
      return reply.send({ status: 'resumed' });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to resume runtime',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Config endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/config', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { config, warnings } = loadConfig(projectRoot);
      const configJson = JSON.stringify(config);
      const redacted = redactSecrets(configJson);
      return reply.send({
        config: JSON.parse(redacted),
        warnings,
      });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read configuration',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.get('/api/providers', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { config } = loadConfig(projectRoot);
      const providers: Record<string, unknown> = {};

      for (const [name, provider] of Object.entries(config.providers)) {
        const p = provider as ProviderEntry;
        providers[name] = {
          priority: p.priority,
          models: p.models,
          baseUrl: p.baseUrl,
          hasAccounts: p.accounts ? Object.keys(p.accounts).length : 0,
          status: 'unknown',
        };
      }

      return reply.send({ providers });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list providers',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Notes endpoints
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/notes', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const queue = getUnhandledNotesQueue(saivageDir(projectRoot));
      const enriched = queue.map((entry: { card_id: string; note_id: string; timestamp: string; kind: string }) => {
        const notes = getNotes(saivageDir(projectRoot), entry.card_id);
        const note = notes.find((n: { id: string }) => n.id === entry.note_id);
        return { ...entry, note };
      });

      return reply.send({ notes: enriched, total: enriched.length });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to list notes',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  fastify.post('/api/notes/:id/acknowledge', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const noteId = params.id;
      const cardId = findCardForNote(projectRoot, noteId);
      if (!cardId) {
        return reply.status(404).send({ error: 'Note not found', noteId });
      }

      const updated = markNoteHandled(saivageDir(projectRoot), cardId, noteId);
      return reply.send({ note: updated });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Note not found', noteId: params.id });
      }
      return reply.status(500).send({ error: 'Failed to acknowledge note', message });
    }
  });

  fastify.delete('/api/notes/:id', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const noteId = params.id;
      const cardId = findCardForNote(projectRoot, noteId);
      if (!cardId) {
        return reply.status(404).send({ error: 'Note not found', noteId });
      }

      deleteNote(saivageDir(projectRoot), cardId, noteId);
      return reply.status(204).send();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found')) {
        const params = request.params as { id: string };
        return reply.status(404).send({ error: 'Note not found', noteId: params.id });
      }
      if (message.includes('handled')) {
        return reply.status(400).send({ error: 'Cannot delete handled note', message });
      }
      return reply.status(500).send({ error: 'Failed to delete note', message });
    }
  });

  fastify.delete('/api/notes', async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const queue = getUnhandledNotesQueue(saivageDir(projectRoot));
      const deletedIds: string[] = [];

      for (const entry of queue) {
        try {
          const notes = getNotes(saivageDir(projectRoot), entry.card_id);
          const note = notes.find((n: { id: string; handled: boolean }) => n.id === entry.note_id);
          if (note && !note.handled) {
            deleteNote(saivageDir(projectRoot), entry.card_id, entry.note_id);
            deletedIds.push(entry.note_id);
          }
        } catch {
          // Skip
        }
      }

      return reply.send({ deleted: deletedIds.length, noteIds: deletedIds });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to clear notes',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

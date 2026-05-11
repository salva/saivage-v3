import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { readRuntimeState, updateRuntimeState } from '../../utils/runtime-state.js';
import { loadConfig, type ProviderEntry } from '../../agents/config-schema.js';
import { getUnhandledNotesQueue, markNoteHandled, deleteNote, getNotes } from '../../utils/notes.js';
import { redactSecrets } from '../../utils/file-access-security.js';
import { CardStore } from '../../utils/card-store.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** Read agent session file — returns null if not found or parse error. */
function readAgentSession(projectRoot: string, sessionId: string): Record<string, unknown> | null {
  const sessionPath = join(projectRoot, '.saivage', 'agents', 'sessions', `${sessionId}.json`);
  if (!existsSync(sessionPath)) return null;
  try {
    return JSON.parse(readFileSync(sessionPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Read agent message lines — returns empty array if not found or unparseable. */
function readAgentMessages(projectRoot: string, sessionId: string): unknown[] {
  const messagesPath = join(projectRoot, '.saivage', 'agents', 'messages', `${sessionId}.jsonl`);
  if (!existsSync(messagesPath)) return [];
  const messages: unknown[] = [];
  for (const line of readFileSync(messagesPath, 'utf-8').split('\n')) {
    if (line.trim()) {
      try { messages.push(JSON.parse(line)); } catch { /* skip */ }
    }
  }
  return messages;
}

/** Safe agent session ID validation pattern. */
const SAFE_AGENT_ID_RE = /^[a-zA-Z0-9_-]+$/;

// ── Route Registration ────────────────────────────────────────

export function registerRuntimeConfigNotesRoutes(
  fastify: FastifyInstance,
  projectRoot: string,
  onPause?: () => void,
  onResume?: () => void,
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
      // Notify ActiveRuntime if callback provided (for in-memory _paused flag)
      onPause?.();
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
      // Notify ActiveRuntime if callback provided (for in-memory _paused flag)
      onResume?.();
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
      // Return a partial/default config with a warning message
      // instead of a 500 so the UI always has something to work with.
      return reply.send({
        config: {
          server: { port: 8080, host: '0.0.0.0' },
        },
        warnings: [
          `Configuration could not be fully loaded: ${err instanceof Error ? err.message : String(err)}`,
        ],
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
      return reply.send({
        providers: {},
        warnings: [
          `Providers could not be loaded: ${err instanceof Error ? err.message : String(err)}`,
        ],
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  // Agents / Conversation endpoint
  // ═══════════════════════════════════════════════════════════

  fastify.get('/api/agents/:id/conversation', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = request.params as { id: string };
      const sessionId = params.id;

      // Validate session ID
      if (!SAFE_AGENT_ID_RE.test(sessionId)) {
        return reply.status(400).send({ error: 'Invalid agent session ID' });
      }

      const session = readAgentSession(projectRoot, sessionId);
      if (!session) {
        return reply.status(404).send({ error: 'Agent session not found', sessionId });
      }

      const messages = readAgentMessages(projectRoot, sessionId);

      return reply.send({ session, messages });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to read agent conversation',
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

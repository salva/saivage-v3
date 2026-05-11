import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { EventLogger } from '../../utils/event-logger.js';
import type { LoggedEvent, EventKind } from '../../schemas/types.js';

// ── Query Parameter Schema ───────────────────────────────────

interface EventsQuery {
  kind?: string;
  session_id?: string;
  goal_id?: string;
  limit?: string;
  offset?: string;
}

// ── Helpers ──────────────────────────────────────────────────

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 50;
  return Math.min(parsed, 500);
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

// ── Route Registration ───────────────────────────────────────

export function registerEventsRoute(
  fastify: FastifyInstance,
  projectRoot: string,
): void {
  // EventLogger is initialized with the saivage directory path,
  // which contains the runtime/events.jsonl file.
  const saivageDir = join(projectRoot, '.saivage');

  fastify.get('/api/events', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const query = request.query as EventsQuery;
      const limit = parseLimit(query.limit);
      const offset = parseOffset(query.offset);

      const eventLogger = new EventLogger(saivageDir);

      // Build the content filter (without offset/limit)
      const contentFilter: {
        kind?: EventKind;
        goal_id?: string;
        session_id?: string;
      } = {};

      if (query.kind) {
        contentFilter.kind = query.kind as EventKind;
      }
      if (query.goal_id) {
        contentFilter.goal_id = query.goal_id;
      }
      if (query.session_id) {
        contentFilter.session_id = query.session_id;
      }

      // Get total matching events (without offset/limit, so total
      // counts events matching the content filters BEFORE pagination)
      const total = eventLogger.getEvents(contentFilter).length;

      // Get the paginated slice
      const events = eventLogger.getEvents({
        ...contentFilter,
        offset,
        limit,
      });

      // Clean up the EventLogger's flush timer
      eventLogger.close();

      return reply.send({ events: events as LoggedEvent[], total });
    } catch (err) {
      return reply.status(500).send({
        error: 'Failed to query events',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

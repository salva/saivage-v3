import { join } from 'node:path';
import { EventLogger } from '../../observability/index.js';
import type { EventFilter } from '../../observability/index.js';
import type { EventKind, LoggedEvent } from '../../schemas/index.js';
import type { EventsListResponse, EventsQuery } from '../../contracts/index.js';

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const parsed = Number(raw);
  return Math.min(parsed, 500);
}

function parseOffset(raw: string | undefined): number {
  if (raw === undefined) return 0;
  return Number(raw);
}

export class EventsReadModelService {
  private readonly eventLogger: EventLogger;

  constructor(projectRoot: string) {
    this.eventLogger = new EventLogger(join(projectRoot, '.saivage'));
  }

  listEvents(query: EventsQuery = {}): EventsListResponse {
    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);
    const contentFilter: EventFilter = {};
    if (query.kind) contentFilter.kind = query.kind as EventKind;
    if (query.goal_id) contentFilter.goal_id = query.goal_id;
    if (query.session_id) contentFilter.session_id = query.session_id;

    const allMatching = this.eventLogger.getEvents(contentFilter);
    const total = allMatching.length;
    const events = allMatching.slice(offset, offset + limit);
    return { events: events as LoggedEvent[], total };
  }

  errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

import { readAppLogEntries } from '../../persistence/app-log.js';
import { loggedEventSchema, type LoggedEvent } from '../../schemas/index.js';
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
  constructor(private readonly projectRoot: string) {}

  listEvents(query: EventsQuery = {}): EventsListResponse {
    const limit = parseLimit(query.limit);
    const offset = parseOffset(query.offset);
    let allMatching = readAppLogEntries(this.projectRoot, 'event').map((entry) => entry.data);
    if (query.kind) allMatching = allMatching.filter((event) => event.kind === query.kind);
    if (query.goal_id) allMatching = allMatching.filter((event) => 'goal_id' in event && event.goal_id === query.goal_id);
    if (query.session_id) allMatching = allMatching.filter((event) => 'session_id' in event && event.session_id === query.session_id);
    const total = allMatching.length;
    const events = allMatching.slice(offset, offset + limit);
    return { events: events as LoggedEvent[], total };
  }

  errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}

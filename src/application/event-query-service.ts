import { readAppLogEntries } from '../persistence/app-log.js';
import { isErrorEvent, type ErrorEvent, type EventKind, type LoggedEvent } from '../schemas/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { EVENT_QUERY_MAX_LIMIT } from '../contracts/builtin-tool-inputs.js';

export { EVENT_QUERY_MAX_LIMIT } from '../contracts/builtin-tool-inputs.js';
export type EventSelection = 'oldest_page' | 'newest_tail';
export interface EventQuery {
  kind?: EventKind;
  goal_id?: string;
  card_id?: string;
  offset?: number;
  limit?: number;
  selection?: EventSelection;
}

export class EventQueryService {
  constructor(readonly projectRoot: string) {}
  queryEvents(query: EventQuery = {}): { events: LoggedEvent[]; total: number } {
    const selection = query.selection ?? 'oldest_page';
    const offset = query.offset ?? 0;
    const limit = query.limit ?? 50;
    validateQuery(selection, offset, limit);
    let matching = readAppLogEntries(this.projectRoot, 'event').map((entry) => redactForOutbound({ source: 'logged-event', value: entry.data }));
    if (query.kind) matching = matching.filter((event) => event.kind === query.kind);
    if (query.goal_id) matching = matching.filter((event) => 'goal_id' in event && event.goal_id === query.goal_id);
    if (query.card_id) matching = matching.filter((event) => 'card_id' in event && event.card_id === query.card_id);
    const total = matching.length;
    return { events: selection === 'newest_tail' ? matching.slice(-limit) : matching.slice(offset, offset + limit), total };
  }
  queryErrors(limit?: number): { errors: ErrorEvent[]; total: number } {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0 || limit > EVENT_QUERY_MAX_LIMIT)) throw new Error(`Event query limit must be a positive safe integer no greater than ${EVENT_QUERY_MAX_LIMIT}.`);
    const matching = readAppLogEntries(this.projectRoot, 'event')
      .map((entry) => redactForOutbound({ source: 'logged-event', value: entry.data }))
      .filter(isErrorEvent);
    return { errors: limit === undefined ? matching : matching.slice(-limit), total: matching.length };
  }
}

function validateQuery(selection: EventSelection, offset: number, limit: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Event query offset must be a nonnegative safe integer.');
  if (!Number.isSafeInteger(limit) || limit <= 0 || limit > EVENT_QUERY_MAX_LIMIT) throw new Error(`Event query limit must be a positive safe integer no greater than ${EVENT_QUERY_MAX_LIMIT}.`);
  if (selection === 'newest_tail' && offset !== 0) throw new Error('Newest-tail event queries forbid a nonzero offset.');
}

import { randomUUID } from 'node:crypto';
import { loggedEventSchema, type LoggedEvent } from '../schemas/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { appendAppLogEntry, type AppLogPublicationContext } from '../persistence/app-log.js';

// ── Constants ─────────────────────────────────────────────────

// ── Event ID Generator ───────────────────────────────────────

let eventCounter = 0;

function nextEventId(): string {
  eventCounter++;
  // Use a short UUID prefix + counter for uniqueness without full UUID cost
  const shortId = randomUUID().split('-')[0] ?? randomUUID();
  return `evt-${shortId}-${Date.now()}-${eventCounter}`;
}

// ── Filter Type ──────────────────────────────────────────────


// ── Event Input Type ─────────────────────────────────────────

/**
 * Input type for appendEvent. Accepts any object with a `kind` field
 * matching an EventKind, plus optional overrides for id/timestamp
 * and any other fields the specific event variant needs.
 */
export type AppendEventInput = LoggedEvent extends infer Event
  ? Event extends LoggedEvent
    ? Omit<Event, 'id' | 'timestamp'> & Partial<Pick<Event, 'id' | 'timestamp'>>
    : never
  : never;

// ── Helpers ──────────────────────────────────────────────────

// ── Event log producer ───────────────────────────────────────

export interface EventLog {
  appendEvent(event: AppendEventInput, context?: AppLogPublicationContext): LoggedEvent;
  appendEventPrepared(prepareEvent: () => AppendEventInput, context?: AppLogPublicationContext): LoggedEvent;
}

export function createEventLog(projectRoot: string, timelineChanged: () => void = () => undefined): EventLog {
  const appendPrepared = (prepareEvent: () => AppendEventInput, context: AppLogPublicationContext = {}): LoggedEvent => {
    const entry = appendAppLogEntry(projectRoot, 'event', () => {
      const event = prepareEvent();
      return {
        type: 'event',
        data: redactForOutbound({ source: 'logged-event', value: loggedEventSchema.parse({
          ...event,
          id: event.id ?? nextEventId(),
          timestamp: event.timestamp ?? new Date().toISOString(),
        }) }),
      };
    }, context);
    timelineChanged();
    return entry.data;
  };
  return {

  /**
   * Append an event to the log. The event gets an auto-generated id and
   * timestamp if not already provided. Returns the full event object.
   */
  appendEvent(event: AppendEventInput, context: AppLogPublicationContext = {}): LoggedEvent {
    return appendPrepared(() => event, context);
  },

  appendEventPrepared: appendPrepared,
  };
}

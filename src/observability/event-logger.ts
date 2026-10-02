import { randomUUID } from 'node:crypto';
import { loggedEventSchema, type LoggedEvent } from '../schemas/index.js';
import { projectLoggedEvent } from './logged-event-projection.js';
import { appendAppLogEntry, type AppLogPublicationContext } from '../persistence/index.js';

// ── Event ID Generator ───────────────────────────────────────

let eventCounter = 0;

function nextEventId(): string {
  eventCounter++;
  // Use an eight-character UUID prefix plus counter.
  const shortId = randomUUID().slice(0, 8);
  return `evt-${shortId}-${Date.now()}-${eventCounter}`;
}

// ── Event Input Type ─────────────────────────────────────────

/**
 * Input type for appendEvent. Accepts any object with a `kind` field
 * matching an EventKind, plus optional overrides for id/timestamp
 * and any other fields the specific event variant needs.
 */
type AppendEventInput = LoggedEvent extends infer Event
  ? Event extends LoggedEvent
    ? Omit<Event, 'id' | 'timestamp'> & Partial<Pick<Event, 'id' | 'timestamp'>>
    : never
  : never;

// ── Event log producer ───────────────────────────────────────

export interface EventLog {
  appendEvent(event: AppendEventInput, context?: AppLogPublicationContext): LoggedEvent;
  appendEventPrepared(
    prepareEvent: () => AppendEventInput,
    context?: AppLogPublicationContext,
  ): LoggedEvent;
}

export function createEventLog(projectRoot: string): EventLog {
  const appendPrepared = (
    prepareEvent: () => AppendEventInput,
    context: AppLogPublicationContext = {},
  ): LoggedEvent => {
    const entry = appendAppLogEntry(
      projectRoot,
      'event',
      () => {
        const event = prepareEvent();
        return {
          type: 'event',
          data: projectLoggedEvent(
            loggedEventSchema.parse({
              ...event,
              id: event.id ?? nextEventId(),
              timestamp: event.timestamp ?? new Date().toISOString(),
            }),
          ),
        };
      },
      context,
    );
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

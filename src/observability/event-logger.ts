import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { LoggedEvent, EventKind } from '../schemas/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { loggedEventSchema } from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { registerEventLogProjection } from '../projections/index.js';
import { readAppLogEntries } from '../persistence/app-log.js';
import { appLogFile, saivageLogsRoot } from '../persistence/layout.js';

// ── Constants ─────────────────────────────────────────────────

function eventsPath(saivageDir: string): string {
  const projectRoot = saivageDir.endsWith('/.saivage') ? saivageDir.slice(0, -'/.saivage'.length) : saivageDir;
  return appLogFile(projectRoot);
}

// ── Event ID Generator ───────────────────────────────────────

let eventCounter = 0;

function nextEventId(): string {
  eventCounter++;
  // Use a short UUID prefix + counter for uniqueness without full UUID cost
  const shortId = randomUUID().split('-')[0] ?? randomUUID();
  return `evt-${shortId}-${Date.now()}-${eventCounter}`;
}

// ── Filter Type ──────────────────────────────────────────────

export interface EventFilter {
  kind?: EventKind | EventKind[];
  goal_id?: string;
  card_id?: string;
  session_id?: string;
  since?: string; // ISO timestamp — return events after this time
  limit?: number;
  offset?: number; // number of events to skip before applying limit
}

// ── Event Input Type ─────────────────────────────────────────

/**
 * Input type for appendEvent. Accepts any object with a `kind` field
 * matching an EventKind, plus optional overrides for id/timestamp
 * and any other fields the specific event variant needs.
 */
export type AppendEventInput = {
  kind: EventKind;
  id?: string;
  timestamp?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
};

// ── Helpers ──────────────────────────────────────────────────

function getGoalId(e: LoggedEvent): string | undefined {
  if ('goal_id' in e) {
    return (e as unknown as Record<string, unknown>).goal_id as string | undefined;
  }
  return undefined;
}

function getCardId(e: LoggedEvent): string | undefined {
  if ('card_id' in e) {
    return (e as unknown as Record<string, unknown>).card_id as string | undefined;
  }
  return undefined;
}

function getSessionId(e: LoggedEvent): string | undefined {
  if ('session_id' in e) {
    return (e as unknown as Record<string, unknown>).session_id as string | undefined;
  }
  return undefined;
}

// ── EventLogger ──────────────────────────────────────────────

export class EventLogger {
  private saivageDir: string;
  private logPath: string;
  private readonly eventBus: EventBus;

  constructor(saivageDir: string, eventBus = new EventBus()) {
    this.saivageDir = saivageDir;
    this.logPath = eventsPath(saivageDir);
    this.eventBus = eventBus;
    registerEventLogProjection(this.eventBus, this.saivageDir, ['event_log_record_appended']);

    mkdirSync(saivageLogsRoot(this.saivageDir.endsWith('/.saivage') ? this.saivageDir.slice(0, -'/.saivage'.length) : this.saivageDir), { recursive: true });
  }

  /**
   * Append an event to the log. The event gets an auto-generated id and
   * timestamp if not already provided. Returns the full event object.
   */
  appendEvent(event: AppendEventInput): LoggedEvent {
    const fullEvent: LoggedEvent = redactForOutbound({
      ...event,
      id: event.id ?? nextEventId(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    }, 'observability.log', { source: 'event-logger' }) as unknown as LoggedEvent;

    const parsed = loggedEventSchema.safeParse(fullEvent);
    if (!parsed.success) {
      throw new Error(`LoggedEvent validation failed for kind '${event.kind}': ${parsed.error.message}`);
    }

    this.eventBus.emit('event_log_record_appended', { record: parsed.data as unknown as Record<string, unknown> });
    return parsed.data;
  }

  /**
   * Get events, with optional filtering.
   * Reads from the persisted file, so it reflects all events.
   *
   * Filtering order:
   * 1. Apply all content filters (kind, goal_id, card_id, session_id, since).
   * 2. Apply offset (default 0) to skip the first N matching events.
   * 3. Apply limit to cap the returned slice (if undefined or negative, no cap).
   *
   * Events are returned in file order (chronological, oldest first).
   */
  getEvents(filter?: EventFilter): LoggedEvent[] {
    const projectRoot = this.saivageDir.endsWith('/.saivage') ? this.saivageDir.slice(0, -'/.saivage'.length) : this.saivageDir;
    let events = readAppLogEntries(projectRoot, 'event')
      .map((entry) => loggedEventSchema.safeParse(entry.data))
      .filter((parsed) => parsed.success)
      .map((parsed) => parsed.data);

    // Step 1: Apply content filters
    if (filter) {
      if (filter.kind) {
        const kinds = Array.isArray(filter.kind) ? filter.kind : [filter.kind];
        events = events.filter((e) => kinds.includes(e.kind));
      }
      if (filter.goal_id) {
        events = events.filter((e) => getGoalId(e) === filter.goal_id);
      }
      if (filter.card_id) {
        events = events.filter((e) => getCardId(e) === filter.card_id);
      }
      if (filter.session_id) {
        events = events.filter((e) => getSessionId(e) === filter.session_id);
      }
      if (filter.since) {
        events = events.filter((e) => e.timestamp >= filter.since!);
      }
    }

    // Step 2 & 3: Apply offset and limit pagination
    if (filter) {
      const offset = filter.offset ?? 0;
      const effectiveOffset = Math.max(0, offset);

      if (filter.limit !== undefined && filter.limit >= 0) {
        events = events.slice(effectiveOffset, effectiveOffset + filter.limit);
      } else {
        // No limit (undefined or negative) — return everything after offset
        events = events.slice(effectiveOffset);
      }
    }

    return events;
  }

  /**
   * Get the path to the events file.
   */
  getLogPath(): string {
    return this.logPath;
  }
}

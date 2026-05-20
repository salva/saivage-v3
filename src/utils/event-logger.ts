import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './file-tree.js';
import type { LoggedEvent, EventKind } from '../schemas/types.js';
import { redactObservabilityValue } from './observability-redaction.js';
import { loggedEventSchema, parseLoggedEventCompat } from '../schemas/validators.js';

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_LOG_FILE = 'events.jsonl';

function eventsPath(saivageDir: string): string {
  return join(saivageDir, 'runtime', DEFAULT_LOG_FILE);
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
  private buffer: string[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly FLUSH_INTERVAL_MS = 100; // flush every 100ms

  constructor(saivageDir: string) {
    this.saivageDir = saivageDir;
    this.logPath = eventsPath(saivageDir);

    // Ensure the runtime directory exists
    mkdirSync(join(this.saivageDir, 'runtime'), { recursive: true });

    // Start periodic flush timer
    this.flushTimer = setInterval(() => this.flush(), this.FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /**
   * Append an event to the log. The event gets an auto-generated id and
   * timestamp if not already provided. Returns the full event object.
   */
  appendEvent(event: AppendEventInput): LoggedEvent {
    const fullEvent: LoggedEvent = redactObservabilityValue({
      ...event,
      id: event.id ?? nextEventId(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    }) as unknown as LoggedEvent;

    const parsed = loggedEventSchema.safeParse(fullEvent);
    if (!parsed.success) {
      throw new Error(`LoggedEvent validation failed for kind '${event.kind}': ${parsed.error.message}`);
    }

    // Add to buffer for batched flush
    this.buffer.push(JSON.stringify(parsed.data));

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
    // Flush buffer first to ensure all events are on disk
    this.flushSync();

    if (!existsSync(this.logPath)) {
      return [];
    }

    const raw = readFileSync(this.logPath, 'utf-8');
    if (raw.trim() === '') return [];

    let events: LoggedEvent[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const parsed = parseLoggedEventCompat(JSON.parse(line));
        if (parsed.ok && parsed.compatibility === 'strict') {
          events.push(parsed.event);
        } else if (parsed.ok) {
          console.warn(parsed.warning);
        }
      } catch {
        // Skip malformed lines
      }
    }

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

  /**
   * Flush buffered events to disk (async via setInterval).
   * Also called before reading to ensure consistency.
   */
  flush(): void {
    if (this.buffer.length === 0) return;

    const lines = this.buffer.splice(0);
    try {
      const existingContent = existsSync(this.logPath) ? readFileSync(this.logPath, 'utf-8') : '';
      writeFileAtomic(this.logPath, existingContent + lines.join('\n') + '\n');
    } catch {
      // Put lines back on failure
      this.buffer.unshift(...lines);
    }
  }

  /**
   * Synchronous flush (for shutdown or before reads).
   * Does NOT kill the periodic flush timer — that only happens in close().
   */
  flushSync(): void {
    this.flush();
  }

  /**
   * Close the logger: flush and stop the flush timer.
   */
  close(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

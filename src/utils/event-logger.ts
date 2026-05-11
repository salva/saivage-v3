import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeFileAtomic } from './file-tree.js';
import type { LoggedEvent, EventKind } from '../schemas/types.js';

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
}

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
  appendEvent(event: Omit<LoggedEvent, 'id' | 'timestamp'> & { id?: string; timestamp?: string }): LoggedEvent {
    const fullEvent: LoggedEvent = {
      ...event,
      id: event.id ?? nextEventId(),
      timestamp: event.timestamp ?? new Date().toISOString(),
    } as unknown as LoggedEvent;

    // Add to buffer for batched flush
    this.buffer.push(JSON.stringify(fullEvent));

    return fullEvent;
  }

  /**
   * Get events, with optional filtering.
   * Reads from the persisted file, so it reflects all events.
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
        const parsed = JSON.parse(line) as LoggedEvent;
        events.push(parsed);
      } catch {
        // Skip malformed lines
      }
    }

    // Apply filters
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
      if (filter.limit !== undefined && filter.limit >= 0) {
        events = events.slice(-filter.limit);
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
   */
  flushSync(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }

  /**
   * Close the logger: flush and stop the flush timer.
   */
  close(): void {
    this.flushSync();
  }
}

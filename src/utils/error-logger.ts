import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactForOutbound } from '../redaction/index.js';
import { EventBus } from '../events/bus.js';
import { registerErrorLogProjection } from '../projections/ledger-projections.js';

// ── Constants ─────────────────────────────────────────────────

const DEFAULT_LOG_FILE = 'errors.jsonl';

function errorsPath(saivageDir: string): string {
  return join(saivageDir, 'runtime', DEFAULT_LOG_FILE);
}

// ── Error ID Generator ────────────────────────────────────────

let errorCounter = 0;

function nextErrorId(): string {
  errorCounter++;
  const shortId = randomUUID().split('-')[0] ?? randomUUID();
  return `err-${shortId}-${Date.now()}-${errorCounter}`;
}

// ── Types ─────────────────────────────────────────────────────

/**
 * Input type for appendError. Accepts a message and optional
 * metadata fields (cardId, goalId, phase), plus any additional
 * key-value pairs the caller wants to persist.
 */
export interface ErrorInput {
  message: string;
  cardId?: string;
  goalId?: string;
  phase?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * A persisted error record, with auto-generated id and timestamp
 * if not provided.
 */
export interface ErrorRecord {
  id: string;
  timestamp: string;
  kind: 'error';
  message: string;
  cardId?: string;
  goalId?: string;
  phase?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

/**
 * Optional filter for getErrors(). Fields are AND-ed together.
 * `since` is an ISO timestamp; only records with timestamp >= since
 * are returned.  `limit` returns the N most recent matching records.
 */
export interface ErrorFilter {
  cardId?: string;
  goalId?: string;
  phase?: string;
  since?: string;
  limit?: number;
}

// ── ErrorLogger ───────────────────────────────────────────────

export class ErrorLogger {
  private saivageDir: string;
  private logPath: string;
  private readonly eventBus: EventBus;

  constructor(saivageDir: string, eventBus = new EventBus()) {
    this.saivageDir = saivageDir;
    this.logPath = errorsPath(saivageDir);
    this.eventBus = eventBus;
    registerErrorLogProjection(this.eventBus, this.saivageDir);

    // Ensure the runtime directory exists
    mkdirSync(join(this.saivageDir, 'runtime'), { recursive: true });
  }

  /**
   * Append an error to the log. The error gets an auto-generated id
   * and timestamp if not already provided. Returns the full ErrorRecord.
   */
  appendError(error: ErrorInput): ErrorRecord {
    const record: ErrorRecord = redactForOutbound({
      ...error,
      kind: 'error',
      id: error.id ?? nextErrorId(),
      timestamp: error.timestamp ?? new Date().toISOString(),
      // Normalize the well-known field names
      cardId: error.cardId,
      goalId: error.goalId,
      phase: error.phase,
    }, 'error.log', { source: 'error-logger' }) as ErrorRecord;

    this.eventBus.emit('error_log_record_appended', { record: record as unknown as Record<string, unknown> });
    return record;
  }

  /**
   * Get errors, with optional filtering.
   * Reads from the persisted file, so it reflects all written errors.
   */
  getErrors(filter?: ErrorFilter): ErrorRecord[] {
    // Flush buffer first to ensure all errors are on disk
    this.flushSync();

    if (!existsSync(this.logPath)) {
      return [];
    }

    const raw = readFileSync(this.logPath, 'utf-8');
    if (raw.trim() === '') return [];

    let errors: ErrorRecord[] = [];
    for (const line of raw.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as ErrorRecord;
        errors.push(parsed);
      } catch {
        // Skip malformed lines
      }
    }

    // Apply filters
    if (filter) {
      if (filter.cardId !== undefined) {
        errors = errors.filter((e) => e.cardId === filter.cardId);
      }
      if (filter.goalId !== undefined) {
        errors = errors.filter((e) => e.goalId === filter.goalId);
      }
      if (filter.phase !== undefined) {
        errors = errors.filter((e) => e.phase === filter.phase);
      }
      if (filter.since !== undefined) {
        errors = errors.filter((e) => e.timestamp >= filter.since!);
      }
      if (filter.limit !== undefined && filter.limit >= 0) {
        errors = errors.slice(-filter.limit);
      }
    }

    return errors;
  }

  /**
   * Get the path to the errors file.
   */
  getErrorsPath(): string {
    return this.logPath;
  }

  /**
   * Flush buffered errors to disk (async via setInterval).
   * Also called before reading to ensure consistency.
   */
  flush(): void {
    // JsonlLedger appends synchronously under the project lock.
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
    this.flush();
  }
}

import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { redactForOutbound } from '../redaction/index.js';
import { EventBus } from '../events/index.js';
import { registerErrorLogProjection } from '../projections/index.js';
import { readAppLogEntries } from '../persistence/app-log.js';
import { appLogFile, saivageLogsRoot } from '../persistence/layout.js';

// ── Constants ─────────────────────────────────────────────────

function errorsPath(saivageDir: string): string {
  const projectRoot = saivageDir.endsWith('/.saivage') ? saivageDir.slice(0, -'/.saivage'.length) : saivageDir;
  return appLogFile(projectRoot);
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

    mkdirSync(saivageLogsRoot(this.saivageDir.endsWith('/.saivage') ? this.saivageDir.slice(0, -'/.saivage'.length) : this.saivageDir), { recursive: true });
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
    const projectRoot = this.saivageDir.endsWith('/.saivage') ? this.saivageDir.slice(0, -'/.saivage'.length) : this.saivageDir;
    let errors = readAppLogEntries(projectRoot, 'error').map((entry) => entry.data as ErrorRecord);

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
}

import { randomUUID } from 'node:crypto';
import { redactForOutbound } from '../redaction/index.js';
import { EventBus } from '../events/index.js';
import { appendAppLogEntry, errorRecordSchema, readAppLogEntries, type AppLogContext, type ErrorInput, type ErrorRecord } from '../persistence/app-log.js';
import { appLogFile } from '../persistence/layout.js';

// ── Constants ─────────────────────────────────────────────────

// ── Error ID Generator ────────────────────────────────────────

let errorCounter = 0;

function nextErrorId(): string {
  errorCounter++;
  const shortId = randomUUID().split('-')[0] ?? randomUUID();
  return `err-${shortId}-${Date.now()}-${errorCounter}`;
}

export type { ErrorInput, ErrorRecord } from '../persistence/app-log.js';

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

// ── Error log producer ────────────────────────────────────────

export interface ErrorLog {
  appendError(error: ErrorInput): ErrorRecord;
  getErrors(filter?: ErrorFilter): ErrorRecord[];
  getErrorsPath(): string;
}

export function createErrorLog(projectRoot: string, appLogs: AppLogContext, eventBus = new EventBus()): ErrorLog {
  return {

  /**
   * Append an error to the log. The error gets an auto-generated id
   * and timestamp if not already provided. Returns the full ErrorRecord.
   */
  appendError(error: ErrorInput): ErrorRecord {
    const record = errorRecordSchema.parse(redactForOutbound({
      ...error,
      kind: 'error',
      id: error.id ?? nextErrorId(),
      timestamp: error.timestamp ?? new Date().toISOString(),
      // Normalize the well-known field names
      cardId: error.cardId,
      goalId: error.goalId,
      phase: error.phase,
    }, 'error.log', { source: 'error-logger' }));

    appendAppLogEntry(appLogs.projectRoot, { id: record.id, timestamp: record.timestamp, type: 'error', data: record }, appLogs.changes);
    eventBus.emit('error_log_record_appended', { record: record as unknown as Record<string, unknown> });
    return record;
  },

  /**
   * Get errors, with optional filtering.
   * Reads from the persisted file, so it reflects all written errors.
   */
  getErrors(filter?: ErrorFilter): ErrorRecord[] {
    let errors = readAppLogEntries(projectRoot, 'error').map((entry) => entry.data);

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
  },

  /**
   * Get the path to the errors file.
   */
  getErrorsPath(): string { return appLogFile(projectRoot); },
  };
}

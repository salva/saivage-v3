import { join } from 'node:path';
import { z } from 'zod';
import type { DomainEvent, EventKind, EventPayload } from '../events/index.js';
import { toLoggedEvent } from '../events/index.js';
import { JsonlLedger, ProjectLock } from '../persistence/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { cardHistoryEntrySchema, controlActionAuditEntrySchema, loggedEventSchema, notificationRecordSchema } from '../schemas/validators.js';
import type { CardHistoryEntry, ControlActionAuditEntry, LoggedEvent, NotificationRecord } from '../schemas/types.js';
import type { ErrorRecord } from '../utils/error-logger.js';

export interface Projection {
  readonly name: string;
  readonly kinds: readonly EventKind[];
  apply(event: DomainEvent): void | Promise<void>;
}

function runtimeLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', 'runtime', 'project.lock'));
}

function saivageLock(saivageDir: string): ProjectLock {
  return new ProjectLock(join(saivageDir, 'runtime', 'project.lock'));
}

export function notificationLedger(projectRoot: string, path: string): JsonlLedger<NotificationRecord> {
  return new JsonlLedger(path, notificationRecordSchema, runtimeLock(projectRoot), { version: null });
}

export function controlActionLedger(projectRoot: string): JsonlLedger<ControlActionAuditEntry> {
  return new JsonlLedger(join(projectRoot, '.saivage', 'runtime', 'control-actions.jsonl'), controlActionAuditEntrySchema, runtimeLock(projectRoot), { version: null });
}

export function cardHistoryLedger(projectRoot: string, cardId: string): JsonlLedger<CardHistoryEntry> {
  return new JsonlLedger(join(projectRoot, '.saivage', 'cards', 'history', `${cardId}.history.jsonl`), cardHistoryEntrySchema, runtimeLock(projectRoot), { version: null });
}

export function eventLogLedger(saivageDir: string): JsonlLedger<LoggedEvent> {
  return new JsonlLedger(join(saivageDir, 'runtime', 'events.jsonl'), loggedEventSchema, saivageLock(saivageDir), { version: null });
}

export const errorRecordSchema: z.ZodType<ErrorRecord> = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  kind: z.literal('error'),
  message: z.string(),
  cardId: z.string().optional(),
  goalId: z.string().optional(),
  phase: z.string().optional(),
}).passthrough() as z.ZodType<ErrorRecord>;

export function errorLogLedger(saivageDir: string): JsonlLedger<ErrorRecord> {
  return new JsonlLedger(join(saivageDir, 'runtime', 'errors.jsonl'), errorRecordSchema, saivageLock(saivageDir), { version: null });
}

export class EventLogProjection implements Projection {
  readonly name = 'event-log';
  readonly kinds: readonly EventKind[];

  constructor(private readonly saivageDir: string, kinds: readonly EventKind[]) {
    this.kinds = kinds;
  }

  apply(event: DomainEvent): void {
    const record = redactForOutbound(toLoggedEvent(event), 'observability.log', { source: 'event-log-projection' }) as unknown as LoggedEvent;
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger(join(this.saivageDir, 'runtime', 'events.jsonl'), loggedEventSchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, record));
  }
}

export class ErrorLogProjection implements Projection {
  readonly name = 'error-log';
  readonly kinds: readonly EventKind[] = ['runtime_diagnostic', 'runtime_fatal_error', 'runtime_actionable_error', 'subscriber_error'];

  constructor(private readonly saivageDir: string) {}

  apply(event: DomainEvent): void {
    const payload = event.payload as Record<string, unknown>;
    const message = String(payload['error_message'] ?? payload['message'] ?? event.kind);
    const record = redactForOutbound({
      id: `err-${event.id}`,
      timestamp: event.timestamp,
      kind: 'error',
      message,
      cardId: typeof payload['card_id'] === 'string' ? payload['card_id'] : undefined,
      goalId: typeof payload['goal_id'] === 'string' ? payload['goal_id'] : undefined,
      phase: typeof payload['phase'] === 'string' ? payload['phase'] : undefined,
      source_event_kind: event.kind,
      source_event_id: event.id,
    }, 'error.log', { source: 'error-log-projection' }) as ErrorRecord;
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger(join(this.saivageDir, 'runtime', 'errors.jsonl'), errorRecordSchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, record));
  }
}

export function appendNotificationRecord(projectRoot: string, path: string, record: NotificationRecord): NotificationRecord {
  const lock = runtimeLock(projectRoot);
  const ledger = new JsonlLedger(path, notificationRecordSchema, lock, { version: null });
  lock.withLockSync((handle) => ledger.appendSync(handle, record));
  return notificationRecordSchema.parse(record);
}

export function appendControlActionRecord(projectRoot: string, record: ControlActionAuditEntry): ControlActionAuditEntry {
  const lock = runtimeLock(projectRoot);
  const ledger = new JsonlLedger(join(projectRoot, '.saivage', 'runtime', 'control-actions.jsonl'), controlActionAuditEntrySchema, lock, { version: null });
  lock.withLockSync((handle) => ledger.appendSync(handle, record));
  return controlActionAuditEntrySchema.parse(record);
}

export function appendCardHistoryRecord(projectRoot: string, record: CardHistoryEntry): CardHistoryEntry {
  const lock = runtimeLock(projectRoot);
  const ledger = new JsonlLedger(join(projectRoot, '.saivage', 'cards', 'history', `${record.card_id}.history.jsonl`), cardHistoryEntrySchema, lock, { version: null });
  lock.withLockSync((handle) => ledger.appendSync(handle, record));
  return cardHistoryEntrySchema.parse(record);
}

export function appendLoggedEvent(saivageDir: string, record: LoggedEvent): LoggedEvent {
  const lock = saivageLock(saivageDir);
  const ledger = new JsonlLedger(join(saivageDir, 'runtime', 'events.jsonl'), loggedEventSchema, lock, { version: null });
  lock.withLockSync((handle) => ledger.appendSync(handle, record));
  return loggedEventSchema.parse(record);
}

export function appendErrorRecord(saivageDir: string, record: ErrorRecord): ErrorRecord {
  const lock = saivageLock(saivageDir);
  const ledger = new JsonlLedger(join(saivageDir, 'runtime', 'errors.jsonl'), errorRecordSchema, lock, { version: null });
  lock.withLockSync((handle) => ledger.appendSync(handle, record));
  return errorRecordSchema.parse(record);
}

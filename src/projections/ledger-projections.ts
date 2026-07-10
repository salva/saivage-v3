import { z } from 'zod';
import type { DomainEvent, EventBus, EventKind } from '../events/index.js';
import { eventKindValues, toEventLogRecord } from '../events/index.js';
import { JsonlLedger, ProjectLock } from '../persistence/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import type { ControlActionAuditEntry, LoggedEvent } from '../schemas/index.js';
import type { ErrorRecord } from '../observability/index.js';
import { appLogEntrySchema, type AppLogEntry } from '../persistence/app-log.js';
import { appLogFile, appLogLockFile } from '../persistence/layout.js';

export interface Projection {
  readonly name: string;
  readonly kinds: readonly EventKind[];
  apply(event: DomainEvent): void | Promise<void>;
}

const registeredProjectionKeys = new WeakMap<EventBus, Set<string>>();

function runtimeLock(projectRoot: string): ProjectLock {
  return new ProjectLock(appLogLockFile(projectRoot));
}

function saivageLock(saivageDir: string): ProjectLock {
  const projectRoot = saivageDir.endsWith('/.saivage') ? saivageDir.slice(0, -'/.saivage'.length) : saivageDir;
  return new ProjectLock(appLogLockFile(projectRoot));
}

function projectRootFromSaivageDir(saivageDir: string): string {
  return saivageDir.endsWith('/.saivage') ? saivageDir.slice(0, -'/.saivage'.length) : saivageDir;
}

function projectionPayload(event: DomainEvent): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}

function registerProjection(eventBus: EventBus, projection: Projection, options?: { failFast?: boolean }): void {
  let keys = registeredProjectionKeys.get(eventBus);
  if (!keys) {
    keys = new Set<string>();
    registeredProjectionKeys.set(eventBus, keys);
  }
  if (keys.has(projection.name)) return;
  eventBus.subscribeMany([...projection.kinds], (event) => projection.apply(event), {
    propagateErrors: options?.failFast ?? false,
  });
  keys.add(projection.name);
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

export class ControlActionAuditProjection implements Projection {
  readonly name = 'control-action-audit-ledger';
  readonly kinds: readonly EventKind[] = ['control_action_record_appended'];

  constructor(private readonly projectRoot: string) {}

  apply(event: DomainEvent): void {
    const record = projectionPayload(event)['record'];
    if (!record) return;
    const parsed = controlActionAuditEntrySchema.parse(record);
    const lock = runtimeLock(this.projectRoot);
    const ledger = new JsonlLedger<AppLogEntry>(appLogFile(this.projectRoot), appLogEntrySchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, { id: parsed.id, timestamp: parsed.created_at, type: 'control_action', data: parsed }));
  }
}

export class EventLogProjection implements Projection {
  readonly name = 'event-log';
  readonly kinds: readonly EventKind[];

  constructor(private readonly saivageDir: string, kinds: readonly EventKind[] = eventKindValues) {
    this.kinds = kinds;
  }

  apply(event: DomainEvent): void {
    const suppliedRecord = projectionPayload(event)['record'];
    const sourceRecord = suppliedRecord ?? toEventLogRecord(event);
    const record = redactForOutbound(sourceRecord, 'observability.log', { source: 'event-log-projection' }) as unknown as LoggedEvent;
    const parsed = loggedEventSchema.parse(record);
    const projectRoot = projectRootFromSaivageDir(this.saivageDir);
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger<AppLogEntry>(appLogFile(projectRoot), appLogEntrySchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, { id: parsed.id, timestamp: parsed.timestamp, type: 'event', data: parsed }));
  }
}

export class ErrorLogProjection implements Projection {
  readonly name = 'error-log';
  readonly kinds: readonly EventKind[] = ['error_log_record_appended'];

  constructor(private readonly saivageDir: string) {}

  apply(event: DomainEvent): void {
    const record = projectionPayload(event)['record'];
    if (!record) return;
    const parsed = errorRecordSchema.parse(redactForOutbound(record, 'error.log', { source: 'error-log-projection' }));
    const projectRoot = projectRootFromSaivageDir(this.saivageDir);
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger<AppLogEntry>(appLogFile(projectRoot), appLogEntrySchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, { id: parsed.id, timestamp: parsed.timestamp, type: 'error', data: parsed }));
  }
}

export function registerControlActionAuditProjection(eventBus: EventBus, projectRoot: string): void {
  registerProjection(eventBus, new ControlActionAuditProjection(projectRoot), { failFast: true });
}

export function registerEventLogProjection(eventBus: EventBus, saivageDir: string, kinds?: readonly EventKind[]): void {
  registerProjection(eventBus, new EventLogProjection(saivageDir, kinds), { failFast: true });
}

export function registerErrorLogProjection(eventBus: EventBus, saivageDir: string): void {
  registerProjection(eventBus, new ErrorLogProjection(saivageDir), { failFast: true });
}

export function registerLedgerProjections(eventBus: EventBus, options: { projectRoot: string; saivageDir?: string; includeEventLog?: boolean; includeErrorLog?: boolean }): void {
  registerControlActionAuditProjection(eventBus, options.projectRoot);
  if (options.includeEventLog && options.saivageDir) registerEventLogProjection(eventBus, options.saivageDir);
  if (options.includeErrorLog && options.saivageDir) registerErrorLogProjection(eventBus, options.saivageDir);
}

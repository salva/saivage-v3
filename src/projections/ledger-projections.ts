import { join } from 'node:path';
import { z } from 'zod';
import type { DomainEvent, EventBus, EventKind } from '../events/index.js';
import { eventKindValues, toLoggedEvent } from '../events/index.js';
import { JsonlLedger, ProjectLock } from '../persistence/index.js';
import { redactForOutbound } from '../redaction/index.js';
import { cardHistoryEntrySchema, controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import type { CardHistoryEntry, ControlActionAuditEntry, LoggedEvent } from '../schemas/index.js';
import type { ErrorRecord } from '../observability/index.js';

export interface Projection {
  readonly name: string;
  readonly kinds: readonly EventKind[];
  apply(event: DomainEvent): void | Promise<void>;
}

const registeredProjectionKeys = new WeakMap<EventBus, Set<string>>();

function runtimeLock(projectRoot: string): ProjectLock {
  return new ProjectLock(join(projectRoot, '.saivage', 'runtime', 'project.lock'));
}

function saivageLock(saivageDir: string): ProjectLock {
  return new ProjectLock(join(saivageDir, 'runtime', 'project.lock'));
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

export class ControlActionAuditProjection implements Projection {
  readonly name = 'control-action-audit-ledger';
  readonly kinds: readonly EventKind[] = ['control_action_record_appended'];

  constructor(private readonly projectRoot: string) {}

  apply(event: DomainEvent): void {
    const record = projectionPayload(event)['record'];
    if (!record) return;
    const parsed = controlActionAuditEntrySchema.parse(record);
    const lock = runtimeLock(this.projectRoot);
    const ledger = new JsonlLedger(join(this.projectRoot, '.saivage', 'runtime', 'control-actions.jsonl'), controlActionAuditEntrySchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, parsed));
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
    const sourceRecord = suppliedRecord ?? toLoggedEvent(event);
    const record = redactForOutbound(sourceRecord, 'observability.log', { source: 'event-log-projection' }) as unknown as LoggedEvent;
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger(join(this.saivageDir, 'runtime', 'events.jsonl'), loggedEventSchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, loggedEventSchema.parse(record)));
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
    const lock = saivageLock(this.saivageDir);
    const ledger = new JsonlLedger(join(this.saivageDir, 'runtime', 'errors.jsonl'), errorRecordSchema, lock, { version: null });
    lock.withLockSync((handle) => ledger.appendSync(handle, parsed));
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

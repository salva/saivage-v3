import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { notificationRecordSchema } from '../schemas/validators.js';
import type { NotificationRecord, NoteAuthor, ControlActionSurface } from '../schemas/types.js';
import { EventBus } from '../events/bus.js';

export interface NotificationInput {
  id: string;
  kind: NotificationRecord['kind'];
  severity: NotificationRecord['severity'];
  payload_summary: string;
  related_card_id?: string;
  related_note_id?: string;
  related_process_id?: string;
  related_version_seq?: number;
  source_actor: NoteAuthor;
  source_surface: ControlActionSurface;
  created_at?: string;
}

export type NotificationOwnership = 'caller-session' | 'other-session' | 'operator-surface' | 'missing';

function now(): string {
  return new Date().toISOString();
}

function notificationsRoot(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'notifications');
}

function sessionNotificationsPath(projectRoot: string, sessionId: string): string {
  return join(notificationsRoot(projectRoot), 'by-session', `${sessionId}.jsonl`);
}

function operatorNotificationsPath(projectRoot: string): string {
  return join(notificationsRoot(projectRoot), 'operator.jsonl');
}

export class NotificationCenter {
  constructor(private readonly projectRoot: string, private readonly eventBus = new EventBus()) {}

  private append(path: string, record: NotificationRecord): NotificationRecord {
    const parsed = notificationRecordSchema.parse(record);
    mkdirSync(join(path, '..'), { recursive: true });
    appendFileSync(path, `${JSON.stringify(parsed)}\n`, 'utf-8');
    return parsed;
  }

  private readLatest(path: string): NotificationRecord[] {
    if (!existsSync(path)) return [];
    const raw = readFileSync(path, 'utf-8').trim();
    if (!raw) return [];
    const latest = new Map<string, NotificationRecord>();
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      const parsed = notificationRecordSchema.parse(JSON.parse(line) as unknown);
      latest.set(parsed.id, parsed);
    }
    return [...latest.values()].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }

  private buildRecord(sessionId: string | null, input: NotificationInput): NotificationRecord {
    return {
      id: input.id,
      session_id: sessionId,
      kind: input.kind,
      severity: input.severity,
      payload_summary: input.payload_summary,
      related_card_id: input.related_card_id,
      related_note_id: input.related_note_id,
      related_process_id: input.related_process_id,
      related_version_seq: input.related_version_seq,
      source_actor: input.source_actor,
      source_surface: input.source_surface,
      created_at: input.created_at ?? now(),
      delivered_at: null,
      acknowledged_at: null,
    };
  }

  enqueueForSession(sessionId: string, input: NotificationInput): NotificationRecord {
    const record = this.append(sessionNotificationsPath(this.projectRoot, sessionId), this.buildRecord(sessionId, input));
    this.eventBus.emit('notification_added', {
      id: record.id,
      kind: record.kind,
      severity: record.severity,
      related_card_id: record.related_card_id,
      related_note_id: record.related_note_id,
      related_process_id: record.related_process_id,
      related_version_seq: record.related_version_seq,
      created_at: record.created_at,
    });
    return record;
  }

  enqueueForOperator(input: NotificationInput): NotificationRecord {
    const record = this.append(operatorNotificationsPath(this.projectRoot), this.buildRecord(null, input));
    this.eventBus.emit('notification_added', {
      id: record.id,
      kind: record.kind,
      severity: record.severity,
      related_card_id: record.related_card_id,
      related_note_id: record.related_note_id,
      related_process_id: record.related_process_id,
      related_version_seq: record.related_version_seq,
      created_at: record.created_at,
    });
    return record;
  }

  drainPendingForSession(sessionId: string): NotificationRecord[] {
    return this.readLatest(sessionNotificationsPath(this.projectRoot, sessionId)).filter((record) => record.delivered_at === null);
  }

  markDeliveredForSession(sessionId: string, ids: string[]): NotificationRecord[] {
    if (ids.length === 0) return [];
    const path = sessionNotificationsPath(this.projectRoot, sessionId);
    const latest = this.readLatest(path);
    const stamp = now();
    const updated: NotificationRecord[] = [];
    for (const record of latest) {
      if (!ids.includes(record.id) || record.delivered_at !== null) continue;
      updated.push(this.append(path, { ...record, delivered_at: stamp }));
    }
    return updated;
  }

  hasBlockingPendingForSession(sessionId: string): boolean {
    return this.readLatest(sessionNotificationsPath(this.projectRoot, sessionId)).some((record) => record.severity === 'block' && record.acknowledged_at === null);
  }

  listUnacknowledgedBlockingForSession(sessionId: string): NotificationRecord[] {
    return this.readLatest(sessionNotificationsPath(this.projectRoot, sessionId)).filter((record) => record.severity === 'block' && record.acknowledged_at === null);
  }

  classifyForSession(sessionId: string, notificationId: string): NotificationOwnership {
    const sessionRecord = this.readLatest(sessionNotificationsPath(this.projectRoot, sessionId)).find((entry) => entry.id === notificationId) ?? null;
    if (sessionRecord) return 'caller-session';

    const operatorRecord = this.readLatest(operatorNotificationsPath(this.projectRoot)).find((entry) => entry.id === notificationId) ?? null;
    if (operatorRecord) return 'operator-surface';

    const bySessionRoot = join(notificationsRoot(this.projectRoot), 'by-session');
    if (existsSync(bySessionRoot)) {
      for (const fileName of readdirSync(bySessionRoot)) {
        if (fileName === `${sessionId}.jsonl` || !fileName.endsWith('.jsonl')) continue;
        const path = join(bySessionRoot, fileName);
        const record = this.readLatest(path).find((entry) => entry.id === notificationId) ?? null;
        if (record) return 'other-session';
      }
    }

    return 'missing';
  }

  acknowledge(sessionId: string, notificationId: string): NotificationRecord | null {
    const path = sessionNotificationsPath(this.projectRoot, sessionId);
    const record = this.readLatest(path).find((entry) => entry.id === notificationId) ?? null;
    if (!record || record.acknowledged_at !== null) return record;
    const updated = this.append(path, { ...record, acknowledged_at: now() });
    this.eventBus.emit('notification_acknowledged', {
      id: updated.id,
      kind: updated.kind,
      related_card_id: updated.related_card_id,
      related_note_id: updated.related_note_id,
      related_process_id: updated.related_process_id,
      acknowledged_at: updated.acknowledged_at ?? updated.created_at,
    });
    return updated;
  }

  listForOperator(): NotificationRecord[] {
    return this.readLatest(operatorNotificationsPath(this.projectRoot));
  }

  acknowledgeForOperator(notificationId: string): NotificationRecord | null {
    const path = operatorNotificationsPath(this.projectRoot);
    const record = this.readLatest(path).find((entry) => entry.id === notificationId) ?? null;
    if (!record || record.acknowledged_at !== null) return record;
    const updated = this.append(path, { ...record, acknowledged_at: now() });
    this.eventBus.emit('notification_acknowledged', {
      id: updated.id,
      kind: updated.kind,
      related_card_id: updated.related_card_id,
      related_note_id: updated.related_note_id,
      related_process_id: updated.related_process_id,
      acknowledged_at: updated.acknowledged_at ?? updated.created_at,
    });
    return updated;
  }
}

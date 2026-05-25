import type { ControlActionSurface, NoteAuthor } from '../schemas/index.js';
import { EventBus } from '../events/index.js';
import { redactTextForOutbound } from '../redaction/index.js';

const MAX_PENDING = 64;

export interface NotificationQueueEntry {
  kind: string;
  body: string;
  queued_at: string;
  source_actor: NoteAuthor;
  source_surface: ControlActionSurface;
}

export class NotificationCenter {
  private readonly queues = new Map<string, NotificationQueueEntry[]>();

  constructor(_projectRoot: string, private readonly eventBus = new EventBus()) {}

  enqueue(sessionId: string, entry: NotificationQueueEntry): void {
    const queue = this.queues.get(sessionId) ?? [];
    if (queue.length >= MAX_PENDING) {
      const dropped = queue.shift();
      console.warn(`notifications_overflow_dropped ${redactTextForOutbound(JSON.stringify({ sessionId, dropped_kind: dropped?.kind ?? null }), 'notification.transport', { source: 'notification-center' })}`);
    }
    queue.push(entry);
    this.queues.set(sessionId, queue);
    this.eventBus.emit('notification_added', { session_id: sessionId, kind: entry.kind });
  }

  drainPendingForSession(sessionId: string): NotificationQueueEntry[] {
    const pending = this.queues.get(sessionId) ?? [];
    this.queues.delete(sessionId);
    return [...pending];
  }

  queueLengthForSession(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }
}

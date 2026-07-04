import { redactTextForOutbound } from '../redaction/index.js';
import { EventBus } from '../events/index.js';

export type NotificationDeliveryTarget = 'session';

export interface NotificationDeliveryContext {
  target: NotificationDeliveryTarget;
  sessionId: string;
}

export interface NotificationQueueEntry {
  kind: string;
  body: string;
  queued_at: string;
  source_actor: import('../schemas/index.js').NoteAuthor;
  source_surface: import('../schemas/index.js').ControlActionSurface;
}

export interface NotificationDeliveryAdapter {
  readonly name: string;
  deliver(entry: NotificationQueueEntry, context: NotificationDeliveryContext): Promise<void> | void;
}

const projectAdapters = new Map<string, NotificationDeliveryAdapter[]>();
const projectEventBuses = new Map<string, EventBus>();

export function setProjectNotificationEventBus(projectRoot: string, eventBus: EventBus): void {
  projectEventBuses.set(projectRoot, eventBus);
}

export function clearProjectNotificationEventBus(projectRoot: string): void {
  projectEventBuses.delete(projectRoot);
}

function getProjectNotificationEventBus(projectRoot: string): EventBus | undefined {
  return projectEventBuses.get(projectRoot);
}

export function setProjectNotificationDeliveryAdapters(projectRoot: string, adapters: NotificationDeliveryAdapter[]): void {
  projectAdapters.set(projectRoot, [...adapters]);
}

export function clearProjectNotificationDeliveryAdapters(projectRoot: string): void {
  projectAdapters.delete(projectRoot);
}

export function getProjectNotificationDeliveryAdapters(projectRoot: string): NotificationDeliveryAdapter[] {
  return [...(projectAdapters.get(projectRoot) ?? [])];
}

export class NotificationDeliveryService {
  constructor(
    private readonly adapters: NotificationDeliveryAdapter[] = [],
    private readonly eventBus = new EventBus(),
  ) {}

  enqueue(sessionId: string, entry: NotificationQueueEntry): void {
    this.eventBus.emit('notification_added', { session_id: sessionId, notification_kind: entry.kind });
    void this.deliver(entry, { target: 'session', sessionId });
  }

  private async deliver(entry: NotificationQueueEntry, context: NotificationDeliveryContext): Promise<void> {
    await Promise.allSettled(this.adapters.map(async (adapter) => {
      try {
        await adapter.deliver(entry, context);
      } catch (err) {
        console.error(
          `[notifications] Delivery adapter '${adapter.name}' failed: ${
            redactTextForOutbound(err, 'notification.transport', { source: 'notification-delivery' })
          }`,
        );
      }
    }));
  }
}

export function createNotificationDeliveryService(
  projectRoot: string,
  adapters: NotificationDeliveryAdapter[] = getProjectNotificationDeliveryAdapters(projectRoot),
  eventBus = getProjectNotificationEventBus(projectRoot) ?? new EventBus(),
): NotificationDeliveryService {
  return new NotificationDeliveryService(adapters, eventBus);
}

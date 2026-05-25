import { NotificationCenter, type NotificationQueueEntry } from './notification-center.js';
import { redactTextForOutbound } from '../redaction/index.js';

export type NotificationDeliveryTarget = 'session';

export interface NotificationDeliveryContext {
  target: NotificationDeliveryTarget;
  sessionId: string;
}

export interface NotificationDeliveryAdapter {
  readonly name: string;
  deliver(entry: NotificationQueueEntry, context: NotificationDeliveryContext): Promise<void> | void;
}

const projectAdapters = new Map<string, NotificationDeliveryAdapter[]>();
const projectCenters = new Map<string, NotificationCenter>();

export function getProjectNotificationCenter(projectRoot: string): NotificationCenter {
  let center = projectCenters.get(projectRoot);
  if (!center) {
    center = new NotificationCenter(projectRoot);
    projectCenters.set(projectRoot, center);
  }
  return center;
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
    private readonly center: NotificationCenter,
    private readonly adapters: NotificationDeliveryAdapter[] = [],
  ) {}

  enqueue(sessionId: string, entry: NotificationQueueEntry): void {
    this.center.enqueue(sessionId, entry);
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
): NotificationDeliveryService {
  return new NotificationDeliveryService(getProjectNotificationCenter(projectRoot), adapters);
}

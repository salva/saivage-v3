import type { NotificationRecord } from '../schemas/types.js';
import { NotificationCenter, type NotificationInput } from './notification-center.js';
import { RedactionBoundary } from './redaction-boundary.js';

export type NotificationDeliveryTarget = 'session' | 'operator';

export interface NotificationDeliveryContext {
  target: NotificationDeliveryTarget;
  sessionId?: string;
}

export interface NotificationDeliveryAdapter {
  readonly name: string;
  deliver(record: NotificationRecord, context: NotificationDeliveryContext): Promise<void> | void;
}

const projectAdapters = new Map<string, NotificationDeliveryAdapter[]>();

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

  enqueueForSession(sessionId: string, input: NotificationInput): NotificationRecord {
    const record = this.center.enqueueForSession(sessionId, input);
    void this.deliver(record, { target: 'session', sessionId });
    return record;
  }

  enqueueForOperator(input: NotificationInput): NotificationRecord {
    const record = this.center.enqueueForOperator(input);
    void this.deliver(record, { target: 'operator' });
    return record;
  }

  private async deliver(record: NotificationRecord, context: NotificationDeliveryContext): Promise<void> {
    await Promise.allSettled(this.adapters.map(async (adapter) => {
      try {
        await adapter.deliver(record, context);
      } catch (err) {
        console.error(
          `[notifications] Delivery adapter '${adapter.name}' failed for notification '${record.id}': ${
            RedactionBoundary.error(err, { sink: 'notification', source: 'notification-delivery' })
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
  return new NotificationDeliveryService(new NotificationCenter(projectRoot), adapters);
}

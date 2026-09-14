import { randomUUID } from 'node:crypto';
import type { CardNotification } from '../schemas/index.js';
import type { NotificationSubmissionPort, NotificationSubmissionResult } from '../runtime/runtime-api.js';
import type { NotificationUrgency } from '../contracts/builtin-tool-inputs.js';

export function queueNotification(
  cardId: string,
  kind: string,
  body: string,
  urgency: NotificationUrgency,
  submitNotification: NotificationSubmissionPort,
  signal?: AbortSignal,
): Promise<NotificationSubmissionResult> {
  const createdAt = new Date().toISOString();
  const notification: CardNotification = {
    id: randomUUID(),
    content: body,
    created_at: createdAt,
    source: kind,
  };
  return submitNotification(cardId, notification, urgency, signal);
}

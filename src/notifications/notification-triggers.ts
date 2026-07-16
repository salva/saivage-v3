import { randomUUID } from 'node:crypto';
import type { CardNotification, ControlActionSurface, NoteAuthor } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

export type NotificationSourceMeta = { actor: NoteAuthor; surface: ControlActionSurface };

export type QueueNotificationResult = NotifyCardResult & { notificationId?: string };

export function queueNotification(
  cardId: string,
  kind: string,
  body: string,
  _source: NotificationSourceMeta,
  notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult,
): QueueNotificationResult {
  const createdAt = new Date().toISOString();
  const notification: CardNotification = {
    id: randomUUID(),
    content: body,
    created_at: createdAt,
    source: kind,
  };
  const result = notifyCard(cardId, notification);
  return result.ok ? { ...result, notificationId: notification.id } : result;
}

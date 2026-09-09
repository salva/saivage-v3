import { randomUUID } from 'node:crypto';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from '../runtime/runtime-api.js';

export function queueNotification(
  cardId: string,
  kind: string,
  body: string,
  notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult,
): NotifyCardResult {
  const createdAt = new Date().toISOString();
  const notification: CardNotification = {
    id: randomUUID(),
    content: body,
    created_at: createdAt,
    source: kind,
  };
  return notifyCard(cardId, notification);
}

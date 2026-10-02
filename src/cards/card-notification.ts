import { randomUUID } from 'node:crypto';
import type { CardNotification } from '../schemas/index.js';

export function createCardNotification(kind: string, body: string): CardNotification {
  const createdAt = new Date().toISOString();
  return {
    id: randomUUID(),
    content: body,
    created_at: createdAt,
    source: kind,
  };
}

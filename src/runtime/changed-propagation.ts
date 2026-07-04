import type { AnalystIssue, CardStatus } from '../schemas/index.js';
import type { CardStore } from '../cards/store-api.js';
import { sanitizeAnalystText } from '../sanitization/analyst-sanitization.js';
import type { CardNotification } from './actors/card-actor.js';
import type { NotifyCardResult } from './runtime-api.js';

const FLIPPABLE_RESTING: ReadonlySet<CardStatus> = new Set(['done', 'failed', 'cancelled', 'blocked']);

export type ChangeOrigin =
  | { kind: 'analyst_edit'; summary: string }
  | { kind: 'analyst_correction'; issues: AnalystIssue[]; note?: string };

export interface ChangedPropagation {
  flipped: Array<{ card_id: string; previous_status: CardStatus }>;
}

function originSummary(origin: ChangeOrigin): string {
  if (origin.kind === 'analyst_edit') return sanitizeAnalystText(origin.summary, 1000);
  const issueSummary = origin.issues.map((issue) => issue.summary).join('; ');
  return sanitizeAnalystText(`${issueSummary}${origin.note ? `\n${origin.note}` : ''}`, 1000);
}

export function propagateChange(store: CardStore, editedCardId: string, origin: ChangeOrigin, notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult): ChangedPropagation {
  const edited = store.read(editedCardId);
  if (!edited) throw new Error(`Card '${editedCardId}' not found.`);

  const path = [editedCardId, ...store.getAncestors(editedCardId).reverse()];
  const flipped: ChangedPropagation['flipped'] = [];
  let runningAncestorId: string | null = null;

  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (card.status === 'running') {
      runningAncestorId = cardId;
      break;
    }
    if (FLIPPABLE_RESTING.has(card.status)) {
      store.setStatus(cardId, 'changed');
      flipped.push({ card_id: cardId, previous_status: card.status });
    }
  }

  const summary = originSummary(origin);
  if (notifyCard) {
    const notified = new Set<string>();
    const notify = (cardId: string) => {
      if (notified.has(cardId)) return;
      notified.add(cardId);
      notifyCard(cardId, changeNotification(cardId, origin.kind, summary));
    };
    notify(editedCardId);
    if (runningAncestorId) notify(runningAncestorId);
  }

  return { flipped };
}

function changeNotification(cardId: string, kind: ChangeOrigin['kind'], summary: string): CardNotification {
  const createdAt = new Date().toISOString();
  return {
    id: `change:${cardId}:${createdAt}:${Math.random().toString(36).slice(2, 8)}`,
    message: `Card changed: ${summary}`,
    created_at: createdAt,
    reason: kind === 'analyst_correction' ? 'analyst_correction' : 'card_changed',
  };
}

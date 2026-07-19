import { randomUUID } from 'node:crypto';
import type { AnalystIssue, CardStatus } from '../schemas/index.js';
import type { CardService } from '../cards/card-api.js';
import { analystBriefEditEffect } from '../cards/card-api.js';
import { sanitizeAnalystText } from '../sanitization/analyst-sanitization.js';
import type { CardNotification } from '../schemas/index.js';
import type { NotifyCardResult } from './runtime-api.js';

const FLIPPABLE_RESTING: ReadonlySet<CardStatus> = new Set(['done', 'failed', 'blocked']);
const ANALYST_BRIEF_FLIPPABLE: ReadonlySet<CardStatus> = new Set(['blocked', 'done', 'failed']);

export type ChangeOrigin =
  | { kind: 'analyst_edit'; summary: string }
  | { kind: 'analyst_correction'; issues: AnalystIssue[]; note?: string };

export interface ChangedPropagation {
  flipped: Array<{ card_id: string; previous_status: CardStatus }>;
}

type PropagationStore = Pick<CardService, 'read' | 'getAncestors' | 'setStatus'>;

function originSummary(origin: ChangeOrigin): string {
  if (origin.kind === 'analyst_edit') return sanitizeAnalystText(origin.summary, 1000);
  const issueSummary = origin.issues.map((issue) => issue.summary).join('; ');
  return sanitizeAnalystText(`${issueSummary}${origin.note ? `\n${origin.note}` : ''}`, 1000);
}

function ancestorPathIncludingEdited(store: Pick<CardService, 'getAncestors'>, editedCardId: string): string[] {
  return [editedCardId, ...store.getAncestors(editedCardId).reverse()];
}

function ancestorPathExcludingEdited(store: Pick<CardService, 'getAncestors'>, editedCardId: string): string[] {
  return store.getAncestors(editedCardId).reverse();
}

function flipRestingCardsAlongPath(
  store: PropagationStore,
  path: readonly string[],
  flippableStatuses: ReadonlySet<CardStatus>,
): ChangedPropagation & { firstRunningCardId: string | null } {
  const flipped: ChangedPropagation['flipped'] = [];
  let firstRunningCardId: string | null = null;

  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (card.status === 'running') {
      firstRunningCardId = cardId;
      break;
    }
    if (flippableStatuses.has(card.status)) {
      store.setStatus(cardId, 'changed');
      flipped.push({ card_id: cardId, previous_status: card.status });
    }
  }

  return { flipped, firstRunningCardId };
}

function notifyOnce(
  recipients: readonly string[],
  notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult,
  kind: ChangeOrigin['kind'],
  summary: string,
): void {
  const notified = new Set<string>();
  for (const cardId of recipients) {
    if (notified.has(cardId)) continue;
    notified.add(cardId);
    notifyCard(cardId, changeNotification(cardId, kind, summary));
  }
}

function analystBriefEditedCardAndAncestorRecipients(store: PropagationStore, path: readonly string[], editedCardId: string): string[] {
  const recipients = [editedCardId];
  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (cardId !== editedCardId && (card.type === 'goal' || card.type === 'project')) recipients.push(cardId);
    if (card.status === 'running') break;
  }
  return recipients;
}

function analystBriefAncestorRecipients(store: PropagationStore, path: readonly string[]): string[] {
  const recipients: string[] = [];
  for (const cardId of path) {
    const card = store.read(cardId);
    if (!card) continue;
    if (card.type === 'goal' || card.type === 'project') recipients.push(cardId);
    if (card.status === 'running') break;
  }
  return recipients;
}

export function propagateChange(store: CardService, editedCardId: string, origin: ChangeOrigin, notifyCard?: (cardId: string, notification: CardNotification) => NotifyCardResult): ChangedPropagation {
  const edited = store.read(editedCardId);
  if (!edited) throw new Error(`Card '${editedCardId}' not found.`);

  const path = ancestorPathIncludingEdited(store, editedCardId);
  const { flipped, firstRunningCardId } = flipRestingCardsAlongPath(store, path, FLIPPABLE_RESTING);

  const summary = originSummary(origin);
  if (notifyCard) {
    notifyOnce(firstRunningCardId ? [editedCardId, firstRunningCardId] : [editedCardId], notifyCard, origin.kind, summary);
  }

  return { flipped };
}

export function propagateAnalystBriefEdit(store: PropagationStore, editedCardId: string, origin: ChangeOrigin, notifyCard: (cardId: string, notification: CardNotification) => NotifyCardResult): ChangedPropagation {
  const edited = store.read(editedCardId);
  if (!edited) throw new Error(`Card '${editedCardId}' not found.`);

  let flipped: ChangedPropagation['flipped'];
  let notifyRecipients: string[];
  const effect = analystBriefEditEffect(edited.status);

  if (effect === null) {
    throw new Error(`Analyst brief edit propagation does not support target card status '${edited.status}'.`);
  }
  if (edited.status === 'running') {
    flipped = [];
    notifyRecipients = [editedCardId];
  } else if (edited.status === 'stopped') {
    const path = ancestorPathIncludingEdited(store, editedCardId);
    flipped = flipRestingCardsAlongPath(store, path, ANALYST_BRIEF_FLIPPABLE).flipped;
    notifyRecipients = analystBriefEditedCardAndAncestorRecipients(store, path, editedCardId);
  } else if (edited.status === 'backlog') {
    const path = ancestorPathExcludingEdited(store, editedCardId);
    flipped = flipRestingCardsAlongPath(store, path, ANALYST_BRIEF_FLIPPABLE).flipped;
    notifyRecipients = analystBriefAncestorRecipients(store, path);
  } else if (effect === 'reopen') {
    const path = ancestorPathIncludingEdited(store, editedCardId);
    flipped = flipRestingCardsAlongPath(store, path, ANALYST_BRIEF_FLIPPABLE).flipped;
    notifyRecipients = analystBriefEditedCardAndAncestorRecipients(store, path, editedCardId);
  } else throw new Error(`Analyst brief edit effect '${effect}' has no propagation path for status '${edited.status}'.`);

  const summary = originSummary(origin);
  notifyOnce(notifyRecipients, notifyCard, origin.kind, summary);

  return { flipped };
}

function changeNotification(cardId: string, kind: ChangeOrigin['kind'], summary: string): CardNotification {
  const createdAt = new Date().toISOString();
  return {
    id: `change:${cardId}:${createdAt}:${randomUUID()}`,
    content: `Card changed: ${summary}`,
    created_at: createdAt,
    source: kind === 'analyst_correction' ? 'analyst_correction' : 'card_changed',
  };
}

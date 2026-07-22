import { z } from 'zod';

import {
  cardIdSchema,
  type BlockedResult,
  type DoneResult,
  type FailedResult,
} from '../schemas/index.js';

export const activateCardArgumentsSchema = z.object({ card_id: cardIdSchema }).strict();

export type ActivateCardArguments = z.infer<typeof activateCardArgumentsSchema>;

export function parseActivateCardArguments(value: unknown): ActivateCardArguments {
  return activateCardArgumentsSchema.parse(value);
}

export type CardActivationOutcome =
  | { status: 'done'; summary: string; result: DoneResult }
  | { status: 'failed'; summary: string; result: FailedResult }
  | { status: 'blocked'; summary: string; result: BlockedResult }
  | { status: 'cancelled'; summary: string };

export type ActivateCardToolResult =
  | { success: true; data: { card_id: string; outcome: 'done'; summary: string; result: DoneResult } }
  | { success: true; data: { card_id: string; outcome: 'failed'; summary: string; result: FailedResult } }
  | { success: true; data: { card_id: string; outcome: 'blocked'; summary: string; result: BlockedResult } }
  | { success: false; error: `Child card '${string}' activation was cancelled.` };

export function formatActivateCardResult(cardId: string, outcome: CardActivationOutcome): ActivateCardToolResult {
  if (outcome.status === 'cancelled') {
    return { success: false, error: `Child card '${cardId}' activation was cancelled.` };
  }
  if (outcome.status === 'done') {
    return { success: true, data: { card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result } };
  }
  if (outcome.status === 'failed') {
    return { success: true, data: { card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result } };
  }
  return { success: true, data: { card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result } };
}

import { z } from 'zod';

import {
  cardIdSchema,
  type BlockedResult,
  type DoneResult,
  type FailedResult,
} from '../schemas/index.js';
import { toolFailed, toolSucceeded, type ToolActionOutcome } from './tool-result.js';

export const activateCardArgumentsSchema = z.object({ card_id: cardIdSchema }).strict();

export type ActivateCardArguments = z.infer<typeof activateCardArgumentsSchema>;

export type CardActivationOutcome =
  | { status: 'done'; summary: string; result: DoneResult }
  | { status: 'failed'; summary: string; result: FailedResult }
  | { status: 'blocked'; summary: string; result: BlockedResult }
  | { status: 'cancelled'; summary: string }
  | { status: 'stopped'; summary: string };

export function formatActivateCardResult(cardId: string, outcome: CardActivationOutcome): ToolActionOutcome {
  if (outcome.status === 'cancelled' || outcome.status === 'stopped') {
    return toolFailed(`Child card '${cardId}' activation was ${outcome.status}.`, { card_id: cardId, outcome: outcome.status, summary: outcome.summary });
  }
  if (outcome.status === 'done') {
    return toolSucceeded({ card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result });
  }
  if (outcome.status === 'failed') {
    return toolSucceeded({ card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result });
  }
  return toolSucceeded({ card_id: cardId, outcome: outcome.status, summary: outcome.summary, result: outcome.result });
}

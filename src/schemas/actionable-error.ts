import { z } from 'zod';

import { cardIdSchema } from './card-id.js';

export const actionableErrorEnvelopeSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  acceptedValues: z.array(z.string()).optional(),
  currentState: z.record(z.string(), z.unknown()).optional(),
  nextAction: z.string().min(1),
  docsRef: z.string().optional(),
  runId: z.string().nullable().optional(),
  sessionId: z.string().nullable().optional(),
  cardId: cardIdSchema.nullable().optional(),
  parentCardId: cardIdSchema.nullable().optional(),
  childCardId: cardIdSchema.nullable().optional(),
}).strict();

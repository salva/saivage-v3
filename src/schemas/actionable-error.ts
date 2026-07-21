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

export type ActionableErrorEnvelope = z.infer<typeof actionableErrorEnvelopeSchema>;

export function createActionableErrorEnvelope(input: ActionableErrorEnvelope): ActionableErrorEnvelope {
  return actionableErrorEnvelopeSchema.parse(input);
}

export function actionableEnumError(
  field: string,
  value: unknown,
  acceptedValues: readonly string[],
  docsRef = 'docs/v3-planner-control-mcp-contract.md',
): ActionableErrorEnvelope {
  return createActionableErrorEnvelope({
    code: 'invalid_enum_value',
    message: `Invalid ${field} '${String(value)}'. Accepted values: ${acceptedValues.join(', ')}.`,
    acceptedValues: [...acceptedValues],
    currentState: { field, value },
    nextAction: `Retry with one of: ${acceptedValues.join(', ')}.`,
    docsRef,
  });
}

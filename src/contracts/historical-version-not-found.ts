import { z } from 'zod';
import {
  cardIdSchema,
  ConversationSessionIdSchema,
  positiveSafeIntegerSchema,
  recordNameSchema,
} from '../schemas/index.js';

export const HistoricalVersionSchema = positiveSafeIntegerSchema;

const AuthoredRecordHistoricalOwnerIdSchema = z.string().refine((ownerId) => {
  const parts = ownerId.split('/');
  return (
    parts.length === 2 &&
    cardIdSchema.safeParse(parts[0]).success &&
    recordNameSchema.safeParse(parts[1]).success
  );
}, 'Expected an exact card-id/record-name authored-record owner id.');

function historicalVersionNotFoundSchema<
  Resource extends 'card' | 'authored_record' | 'conversation',
  OwnerSchema extends z.ZodTypeAny,
>(resourceLiteral: Resource, ownerIdSchema: OwnerSchema) {
  return z
    .object({
      error: z.literal('historical_version_not_found'),
      resource: z.literal(resourceLiteral),
      owner_id: ownerIdSchema,
      version: HistoricalVersionSchema,
    })
    .strict();
}

export const HistoricalVersionNotFoundErrorSchema = historicalVersionNotFoundSchema(
  'card',
  cardIdSchema,
);
export const AuthoredRecordHistoricalVersionNotFoundSchema = historicalVersionNotFoundSchema(
  'authored_record',
  AuthoredRecordHistoricalOwnerIdSchema,
);
export const ConversationHistoricalVersionNotFoundSchema = historicalVersionNotFoundSchema(
  'conversation',
  ConversationSessionIdSchema,
);

export const HistoricalVersionNotFoundSchema = z.discriminatedUnion('resource', [
  HistoricalVersionNotFoundErrorSchema,
  AuthoredRecordHistoricalVersionNotFoundSchema,
  ConversationHistoricalVersionNotFoundSchema,
]);

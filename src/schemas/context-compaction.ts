import { z } from 'zod';

import { agentMessageSchema } from './validators.js';

const positiveSafeInteger = z.number().int().safe().positive();
const nonNegativeSafeInteger = z.number().int().safe().nonnegative();
const canonicalUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

const protectedPromptSchema = z
  .object({
    source: z
      .object({ segmentVersion: positiveSafeInteger, rowIndex: nonNegativeSafeInteger })
      .strict(),
    message: agentMessageSchema,
  })
  .strict();

export const requiredModelFactSlotsSchema = z
  .object({
    latestRecovery: z
      .object({ sourceMessageId: z.string().min(1), activationInputId: canonicalUuidSchema })
      .strict()
      .nullable(),
    latestContentPolicyRefusal: z
      .object({ markerId: canonicalUuidSchema, activationInputId: canonicalUuidSchema })
      .strict()
      .nullable(),
  })
  .strict()
  .superRefine((facts, ctx) => {
    if (
      facts.latestRecovery &&
      facts.latestRecovery.sourceMessageId !==
        `${facts.latestRecovery.activationInputId}:model-recovered`
    )
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['latestRecovery', 'sourceMessageId'],
        message: 'Recovery sourceMessageId must equal the activation-derived recovery identity.',
      });
  });

export const compactedHistorySchema = z
  .object({
    summaryText: z.string().min(1),
    protectedPrompts: z.array(protectedPromptSchema),
    requiredModelFacts: requiredModelFactSlotsSchema,
  })
  .strict();

export type RequiredModelFactSlots = z.infer<typeof requiredModelFactSlotsSchema>;
export type CompactedHistory = z.infer<typeof compactedHistorySchema>;
export type ProtectedPrompt = z.infer<typeof protectedPromptSchema>;

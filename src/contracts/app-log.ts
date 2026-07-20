import { z } from 'zod';

import { cardIdSchema } from '../schemas/card-id.js';
import { contentReviewSchema, controlActionAuditEntrySchema, loggedEventSchema } from '../schemas/index.js';
import { providerExchangeLogDataSchema, providerExchangeLogId } from './provider-exchange-log.js';

export const errorRecordSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().datetime(),
  kind: z.literal('error'),
  message: z.string(),
  cardId: cardIdSchema.optional(),
  goalId: cardIdSchema.optional(),
  phase: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).strict();

export type ErrorRecord = z.infer<typeof errorRecordSchema>;

const eventEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('event'), data: loggedEventSchema }).strict();
const errorEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('error'), data: errorRecordSchema }).strict();
const controlEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('control_action'), data: controlActionAuditEntrySchema }).strict();
const providerEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('provider_exchange'), data: providerExchangeLogDataSchema }).strict();
const contentEntrySchema = z.object({ id: z.string().min(1), timestamp: z.string().datetime(), type: z.literal('content_review'), data: contentReviewSchema }).strict();

export const appLogEntrySchema = z.discriminatedUnion('type', [
  eventEntrySchema,
  errorEntrySchema,
  controlEntrySchema,
  providerEntrySchema,
  contentEntrySchema,
]).superRefine((entry, ctx) => {
  const authoritativeId = entry.type === 'provider_exchange' ? providerExchangeLogId(entry.data) : entry.data.id;
  const authoritativeTime = entry.type === 'control_action' || entry.type === 'content_review' ? entry.data.created_at : entry.data.timestamp;
  if (entry.id !== authoritativeId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['id'], message: 'Outer app-log id must equal the payload identity.' });
  if (entry.timestamp !== authoritativeTime) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['timestamp'], message: 'Outer app-log timestamp must equal the payload timestamp.' });
});

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = AppLogEntry['type'];
export type AppLogEntryOfType<T extends AppLogEntryType> = Extract<AppLogEntry, { type: T }>;

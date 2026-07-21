import { z } from 'zod';

import { providerExchangeLogDataSchema, providerExchangeLogId } from './provider-exchange-log.js';
import { loggedEventSchema } from '../schemas/event-catalog.js';
import { controlActionAuditEntrySchema } from '../schemas/validators.js';

const eventEntrySchema = z.object({ type: z.literal('event'), data: loggedEventSchema }).strict();
const controlEntrySchema = z.object({ type: z.literal('control_action'), data: controlActionAuditEntrySchema }).strict();
const providerEntrySchema = z.object({ type: z.literal('provider_exchange'), data: providerExchangeLogDataSchema }).strict();

export const appLogEntrySchema = z.discriminatedUnion('type', [
  eventEntrySchema,
  controlEntrySchema,
  providerEntrySchema,
]);

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = AppLogEntry['type'];
export type AppLogEntryOfType<T extends AppLogEntryType> = Extract<AppLogEntry, { type: T }>;

export function appLogEntryLogicalId(entry: AppLogEntry): string {
  return entry.type === 'provider_exchange' ? providerExchangeLogId(entry.data) : entry.data.id;
}

export function appLogEntryTimestamp(entry: AppLogEntry): string {
  return entry.type === 'control_action' ? entry.data.created_at : entry.data.timestamp;
}

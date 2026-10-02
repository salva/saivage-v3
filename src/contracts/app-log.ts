import { z } from 'zod';

import { loggedEventSchema, controlActionAuditEntrySchema } from '../schemas/index.js';

const eventEntrySchema = z.object({ type: z.literal('event'), data: loggedEventSchema }).strict();
const controlEntrySchema = z
  .object({ type: z.literal('control_action'), data: controlActionAuditEntrySchema })
  .strict();

export const appLogEntrySchema = z.discriminatedUnion('type', [
  eventEntrySchema,
  controlEntrySchema,
]);

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = AppLogEntry['type'];
export type AppLogEntryOfType<T extends AppLogEntryType> = Extract<AppLogEntry, { type: T }>;

export function appLogEntryLogicalId(entry: AppLogEntry): string {
  return entry.data.id;
}

import { z } from 'zod';

import { loggedEventSchema, controlActionAuditEntrySchema } from '../schemas/index.js';
import { externalPrincipalSchema, uuidV4Schema } from '../schemas/index.js';

export const externalToolCallSchema = z
  .object({
    id: uuidV4Schema,
    principal: externalPrincipalSchema,
    project_identity_digest: z.string().regex(/^[0-9a-f]{64}$/),
    tool: z.union([z.string().regex(/^[a-z][a-z0-9_]{0,63}$/), z.literal('<unsupported>')]),
    created_at: z.string().datetime(),
    execution: z.enum(['rejected_before_execution', 'executed', 'execution_failed']),
    outcome: z.enum(['ok', 'denied', 'error']),
  })
  .strict();
export type ExternalToolCall = z.infer<typeof externalToolCallSchema>;

const eventEntrySchema = z.object({ type: z.literal('event'), data: loggedEventSchema }).strict();
const controlEntrySchema = z
  .object({ type: z.literal('control_action'), data: controlActionAuditEntrySchema })
  .strict();
const externalEntrySchema = z
  .object({ type: z.literal('external_tool_call'), data: externalToolCallSchema })
  .strict();

export const appLogEntrySchema = z.discriminatedUnion('type', [
  eventEntrySchema,
  controlEntrySchema,
  externalEntrySchema,
]);

export type AppLogEntry = z.infer<typeof appLogEntrySchema>;
export type AppLogEntryType = AppLogEntry['type'];
export type AppLogEntryOfType<T extends AppLogEntryType> = Extract<AppLogEntry, { type: T }>;

export function appLogEntryLogicalId(entry: AppLogEntry): string {
  return entry.data.id;
}

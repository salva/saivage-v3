import { z } from 'zod';

import { agentNameSchema } from './agent-name.js';
import { cardIdSchema } from './card-id.js';
import { ConversationSessionIdSchema } from './conversation-session-id.js';
import { positiveSafeIntegerSchema } from './validators.js';

export const cardVersionChangeSchema = z.object({
  entry_id: z.string().uuid(),
  kind: z.enum(['update', 'notification_enqueue', 'notification_remove', 'status', 'terminal', 'child_link', 'reorder', 'delete']),
  card_id: cardIdSchema,
  resulting_version: positiveSafeIntegerSchema,
  changed_at: z.string().datetime(),
  changed_by_actor: z.union([agentNameSchema, z.literal('runtime')]),
  changed_by_surface: z.literal('runtime'),
  changed_fields: z.array(z.string().min(1)).min(1),
  change_summary: z.string().min(1),
  change_reason: z.string().min(1),
  terminal_summary: z.object({ status: z.enum(['done', 'failed', 'blocked']), result_kind: z.enum(['workflow-result', 'runtime-failure', 'content-policy-refusal', 'compaction-summary-blocked']), summary: z.string().min(1), content_policy: z.object({ session_id: ConversationSessionIdSchema, marker_id: z.string().min(1), evidence_url: z.string().min(1), blocked_at: z.string().datetime() }).strict().nullable() }).strict().nullable(),
}).strict().superRefine((change, ctx) => {
  if (new Set(change.changed_fields).size !== change.changed_fields.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Changed fields must be duplicate-free.', path: ['changed_fields'] });
  if ((change.kind === 'update' || change.kind === 'delete') ? change.changed_by_actor === 'runtime' : change.changed_by_actor !== 'runtime') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Card change actor does not match the change kind.', path: ['changed_by_actor'] });
  if ((change.kind === 'terminal') !== (change.terminal_summary !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Terminal summary is present exactly for terminal changes.', path: ['terminal_summary'] });
  if (change.terminal_summary && (change.terminal_summary.result_kind === 'content-policy-refusal') !== (change.terminal_summary.content_policy !== null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Content-policy metadata is present exactly for content-policy refusal.', path: ['terminal_summary', 'content_policy'] });
});

export type CardVersionChange = z.infer<typeof cardVersionChangeSchema>;

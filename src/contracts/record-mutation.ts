import { z } from 'zod';

import { cardIdSchema, positiveSafeIntegerSchema, recordNameSchema } from '../schemas/index.js';
import { uuidV4Schema } from '../persistence/version-index.js';

const operationSchema = z.enum(['write', 'edit']);
const commonIdentity = { card_id: cardIdSchema, name: recordNameSchema } as const;

export const RecordMutationDeniedSchema = z.object({ success: z.literal(false), error: z.literal('Record mutation is not authorized.'), data: z.object({ code: z.literal('record_mutation_denied'), ...commonIdentity, operation: operationSchema, reason: z.enum(['card_not_active', 'writer_not_authorized', 'tool_not_authorized', 'cross_card_scope', 'lifecycle_unsupported']) }).strict() }).strict();
export const RecordMutationCurrentUnavailableSchema = z.object({ success: z.literal(false), error: z.literal('Current record state unavailable; restart required.'), data: z.object({ code: z.literal('current_state_unavailable'), resource: z.enum(['card', 'authored_record']), owner_id: z.string().min(1), operation: operationSchema, restart_required: z.literal(true) }).strict() }).strict();
export const RecordMutationStateFailureSchema = z.discriminatedUnion('error', [
  z.object({ success: z.literal(false), error: z.literal('Record has no content to edit.'), data: z.object({ code: z.literal('record_content_absent'), ...commonIdentity, current_head: positiveSafeIntegerSchema.nullable() }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Record already has an open workflow draft.'), data: z.object({ code: z.literal('record_open_conflict'), ...commonIdentity, current_head: positiveSafeIntegerSchema, operation: operationSchema }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Record content is unchanged.'), data: z.object({ code: z.literal('record_content_unchanged'), ...commonIdentity, current_head: positiveSafeIntegerSchema, operation: operationSchema }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('old_string was not found in current record content.'), data: z.object({ code: z.literal('record_edit_old_string_not_found'), ...commonIdentity, current_head: positiveSafeIntegerSchema }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('old_string matched multiple locations; set replace_all to true.'), data: z.object({ code: z.literal('record_edit_old_string_multiple_matches'), ...commonIdentity, current_head: positiveSafeIntegerSchema, occurrences: positiveSafeIntegerSchema.min(2), replace_all_required: z.literal(true) }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Record content must not be empty.'), data: z.object({ code: z.literal('record_result_content_empty'), ...commonIdentity, current_head: positiveSafeIntegerSchema.nullable(), operation: operationSchema }).strict() }).strict(),
]);
export const RecordMutationFailureSchema = z.union([RecordMutationStateFailureSchema, RecordMutationDeniedSchema, RecordMutationCurrentUnavailableSchema]);

const propagationSchema = z.union([z.object({ ok: z.literal(true) }).strict(), z.object({ ok: z.literal(false), partial: z.literal(true), error: z.string() }).strict()]);
export const RecordMutationSuccessSchema = z.object({ success: z.literal(true), data: z.object({
  ...commonIdentity, state: z.enum(['open', 'closed']), head_version: positiveSafeIntegerSchema, head_entry_id: uuidV4Schema,
   current_url: z.string().min(1), version_url: z.string().min(1), bytes: z.number().int().safe().nonnegative(), written: z.literal(true),
  surface: z.enum(['card_agent', 'analyst']), propagation: propagationSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.surface === 'card_agent' ? data.state !== 'open' || data.propagation !== undefined : data.state !== 'closed' || data.propagation === undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mutation surface, state, and propagation must agree.' });
  const currentUrl = `record:///${encodeURIComponent(data.name)}?card=${encodeURIComponent(data.card_id)}`;
  if (data.current_url !== currentUrl || data.version_url !== `${currentUrl}&v=${data.head_version}`) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mutation result URLs must exactly match the committed head.' });
}) }).strict();

export const RecordMutationResultSchema = z.union([RecordMutationSuccessSchema, RecordMutationFailureSchema]);
export const ModelRecordTargetWireSchema = z.object({
  card_id: cardIdSchema,
  name: recordNameSchema,
  format: z.literal('markdown'),
  schema: z.string().min(1),
  state: z.enum(['absent', 'open', 'closed', 'discarded']),
  head_version: positiveSafeIntegerSchema.nullable(),
  current_url: z.string().min(1),
  version_url: z.string().min(1).nullable(),
}).strict().superRefine((value, ctx) => {
  const currentUrl = `record:///${encodeURIComponent(value.name)}?card=${encodeURIComponent(value.card_id)}`;
  if (value.current_url !== currentUrl) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Current record URL does not match record identity.' });
  if (value.state === 'absent') {
    if (value.head_version !== null || value.version_url !== null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Absent record target must have no head or version URL.' });
    return;
  }
  if (value.head_version === null || value.version_url !== `${currentUrl}&v=${value.head_version}`) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Populated record target must identify its head artifact.' });
});
export const AnalystPreNetworkAdmissionSchema = z.union([
  z.object({ ok: z.literal(true) }).strict(),
  z.object({ ok: z.literal(false), result: z.union([RecordMutationDeniedSchema, RecordMutationStateFailureSchema, RecordMutationCurrentUnavailableSchema]), audit_outcome: z.enum(['denied', 'error']) }).strict().superRefine((value, ctx) => {
    if ((value.result.data.code === 'record_mutation_denied') !== (value.audit_outcome === 'denied')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pre-network audit outcome must match admission result.' });
    if (value.result.data.code !== 'record_mutation_denied' && value.result.data.code !== 'record_open_conflict' && value.result.data.code !== 'current_state_unavailable') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Pre-network admission returned a content-dependent failure.' });
  }),
]);

export type RecordMutationFailure = z.infer<typeof RecordMutationFailureSchema>;
export type RecordMutationSuccess = z.infer<typeof RecordMutationSuccessSchema>;
export type RecordMutationResult = z.infer<typeof RecordMutationResultSchema>;
export type ModelRecordTargetWire = z.infer<typeof ModelRecordTargetWireSchema>;
export type AnalystPreNetworkAdmission = z.infer<typeof AnalystPreNetworkAdmissionSchema>;

export interface ParsedRecordUrl { cardId: string; name: string; version: number|null; currentUrl: string }

export function parseRecordUrl(raw: string): ParsedRecordUrl {
  const match = /^record:\/\/\/([^/?#]+)\?card=([^&#]+)(?:&v=([1-9][0-9]*))?$/.exec(raw);
  if (!match) throw new Error('Invalid record URL.');
  let name: string; let cardId: string;
  try { name = decodeURIComponent(match[1]!); cardId = decodeURIComponent(match[2]!); } catch { throw new Error('Invalid record URL encoding.'); }
  if (/%[0-9a-f]{2}/i.test(name) || /%[0-9a-f]{2}/i.test(cardId)) throw new Error('Record URL must require exactly one decoding pass.');
  if(!recordNameSchema.safeParse(name).success||!cardIdSchema.safeParse(cardId).success)throw new Error('Invalid record URL.');
  const version=match[3]===undefined?null:Number(match[3]);if(version!==null&&!positiveSafeIntegerSchema.safeParse(version).success)throw new Error('Invalid record URL.');
  const currentUrl = `record:///${encodeURIComponent(name)}?card=${encodeURIComponent(cardId)}`;
  return { cardId, name, version, currentUrl };
}

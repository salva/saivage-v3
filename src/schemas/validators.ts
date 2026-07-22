import { z } from 'zod';
import {
  agentEventKindValues,
  eventKindValues,
  runtimeEventKindValues,
  analystIssueSeverityValues,
  cardActionValues,
  cardStatusValues,
  cardTypeValues,
  urgencyValues,
} from './types.js';
import { loggedEventSchema, loggedEventSchemaByKind } from './event-catalog.js';
export { actionableErrorEnvelopeSchema, actionableEnumError, createActionableErrorEnvelope } from './actionable-error.js';
import { roundIdGrammar } from './round-id.js';
import { cardLifecycleStateSchema } from './lifecycle.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolResultMessageId } from './message-identity.js';
import { cardIdSchema, cardParentId } from './card-id.js';
import { parseCanonicalContextCompaction } from './context-compaction.js';
import { agentNameSchema } from './agent-name.js';
import { ConversationSessionIdSchema } from './conversation-session-id.js';
export { nonRootCardIdSchema } from './card-id.js';
export { cardIdSchema };
export { roundIdGrammar, assertRoundId, type RoundKind } from './round-id.js';


function enumFromCatalog(values: readonly string[]) { return z.enum(values as unknown as [string, ...string[]]); }

export const cardTypeSchema = z.enum(cardTypeValues);
export const cardStatusSchema = z.enum(cardStatusValues);
export const cardActionSchema = z.enum(cardActionValues);
export const positiveSafeIntegerSchema = z.number().int().safe().positive();
export const urgencySchema = z.enum(urgencyValues);
export const createdBySchema = z.union([agentNameSchema,z.literal('runtime:bootstrap')]);
export const noteAuthorSchema = z.union([z.literal('user'),z.literal('runtime'),agentNameSchema]);
export const controlActionSurfaceSchema = z.enum(['web-chat', 'rest', 'cli', 'runtime', 'web-ui']);
export const cardNotificationSchema: z.ZodType<import('./types.js').CardNotification> = z.object({ id: z.string().min(1), content: z.string().min(1), created_at: z.string().datetime(), source: z.string().min(1).optional() }).strict();
const cardRecordShape = { id: cardIdSchema, type: cardTypeSchema, children: z.array(cardIdSchema), title: z.string().min(1), lifecycle: cardLifecycleStateSchema, subtype: z.null(), tags: z.array(z.string()), priority: z.number().int(), urgency: urgencySchema, created_by: createdBySchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), version_seq: positiveSafeIntegerSchema, assigned_to: z.null(), depends_on: z.array(cardIdSchema), related: z.array(cardIdSchema), metrics: z.null(), estimate: z.null(), started_at: z.null(), duration_ms: z.null(), status_text: z.string().nullable(), status_text_updated_at: z.string().datetime().nullable(), status_text_author_session_id: z.null(), latest_self_report: z.null(), metadata: z.null(), pending_notifications: z.array(cardNotificationSchema) };
function refineCardLifecycle(card: import('./types.js').CardRecord, ctx: z.RefinementCtx): void {
  if (card.id === 'project' && card.type !== 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The project card is the fixed root.', path: ['id'] });
  if (card.id !== 'project' && card.type === 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only the fixed project card may have type project.', path: ['type'] });
  if (new Set(card.children).size !== card.children.length || card.children.some((id) => cardIdSchema.safeParse(id).success && cardParentId(id) !== card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Card children must be unique immediate hierarchical children.', path: ['children'] });
  if (new Set(card.pending_notifications.map((notification) => notification.id)).size !== card.pending_notifications.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification ids must be unique per card.', path: ['pending_notifications'] });
  if ((card.lifecycle.status === 'done' || card.lifecycle.status === 'failed' || card.lifecycle.status === 'cancelled') && card.pending_notifications.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cards in status '${card.lifecycle.status}' require empty pending_notifications.`, path: ['pending_notifications'] });
}
export const cardRecordSchema: z.ZodType<import('./types.js').CardRecord> = z.lazy(() => z.object(cardRecordShape).strict().superRefine(refineCardLifecycle));
export const cardOperatorSummarySchema: z.ZodType<import('./types.js').CardOperatorSummary> = z.object({ blocked: z.boolean(), hasError: z.boolean(), error: z.string().nullable(), completedAt: z.string().nullable(), stale: z.boolean() }).strict();
export const operatorCardSchema = z.object({ ...cardRecordShape, allowedActions: z.array(cardActionSchema), operator_summary: cardOperatorSummarySchema }).strict().superRefine(refineCardLifecycle);
export const cardViewSchema: z.ZodType<import('./types.js').CardView> = z.object({ card: cardRecordSchema, logical_path: z.string().nullable(), status: cardStatusSchema, parent: cardIdSchema.nullable(), operator_summary: cardOperatorSummarySchema }).strict();
export const cardHistoryKindSchema = z.enum(['update', 'notification_enqueue', 'notification_remove', 'status', 'terminal', 'child_link', 'reorder', 'delete']);
const historyCommonShape = { entry_id: z.string().uuid(), card_id: cardIdSchema, version_seq: positiveSafeIntegerSchema, changed_at: z.string().datetime(), change_reason: z.string().nullable(), changed_fields: z.array(z.string()), change_summary: z.string() };
const historyProvenance = {
  update: { changed_by_actor: agentNameSchema, changed_by_surface: z.literal('runtime') },
  delete: { changed_by_actor: agentNameSchema, changed_by_surface: z.literal('runtime') },
  runtime: { changed_by_actor: z.literal('runtime'), changed_by_surface: z.literal('runtime') },
} as const;
const runtimeHistoryKinds = ['notification_enqueue', 'notification_remove', 'status', 'terminal', 'child_link', 'reorder'] as const;
const historyEntryVariants = [
  z.object({ ...historyCommonShape, kind: z.literal('update'), snapshot: cardRecordSchema, ...historyProvenance.update }).strict(),
  ...runtimeHistoryKinds.map((kind) => z.object({ ...historyCommonShape, kind: z.literal(kind), snapshot: cardRecordSchema, ...historyProvenance.runtime }).strict()),
  z.object({ ...historyCommonShape, kind: z.literal('delete'), snapshot: cardRecordSchema, ...historyProvenance.delete }).strict(),
] as const;
const historyHeaderVariants = [
  z.object({ ...historyCommonShape, kind: z.literal('update'), ...historyProvenance.update }).strict(),
  ...runtimeHistoryKinds.map((kind) => z.object({ ...historyCommonShape, kind: z.literal(kind), ...historyProvenance.runtime }).strict()),
  z.object({ ...historyCommonShape, kind: z.literal('delete'), ...historyProvenance.delete }).strict(),
] as const;
export const cardHistoryHeaderSchema: z.ZodType<import('./types.js').CardHistoryHeader> = z.discriminatedUnion('kind', historyHeaderVariants);
export const cardHistoryEntrySchema: z.ZodType<import('./types.js').CardHistoryEntry> = z.discriminatedUnion('kind', historyEntryVariants);
export const controlActionAuditEntrySchema: z.ZodType<import('./types.js').ControlActionAuditEntry> = z.object({ id: z.string().min(1), actor: noteAuthorSchema, surface: controlActionSurfaceSchema, action: z.string().min(1), target_kind: z.enum(['card', 'note', 'process', 'runtime', 'config', 'session']).nullable(), target_id: z.string().nullable(), params_summary: z.string(), safety_class: z.enum(['read_only', 'low', 'high', 'destructive', 'deployment']).optional(), outcome: z.enum(['ok', 'error', 'denied']), outcome_summary: z.string(), error: z.string().optional(), created_at: z.string().datetime() }).strict();
export const analystIssueSchema: z.ZodType<import('./types.js').AnalystIssue> = z.object({ summary: z.string().min(1), severity: z.enum(analystIssueSeverityValues).optional(), evidence_path: z.string().optional() }).strict();
export const analystIssuesSchema = z.array(analystIssueSchema);
export const projectConfigSchema = z.object({ id: z.literal('project'), name: z.string().min(1), context: z.string(), goals_summary: z.string(), constraints: z.array(z.string()), planner_enabled: z.boolean(), created_at: z.string().datetime(), updated_at: z.string().datetime() });
export const processStatusSchema = z.enum(['running', 'exited', 'failed', 'killed']);
export const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
export const messageKindSchema = z.enum(['text', 'activity', 'tool_call', 'tool_result', 'model_issue', 'model_repair', 'context_compaction', 'model_recovered', 'system_prompt', 'provider_private']);
export const entityLinkSchema = z.object({ entity_type: z.enum(['card', 'process', 'artifact', 'attachment']), entity_id: z.string().min(1), label: z.string().optional() }).strict();
const providerProjectionSchema = z.object({ kind: z.literal('openai_responses'), source_input_id: z.string().uuid(), private_message_id: z.string().min(1), projection_kind: z.enum(['assistant_message', 'assistant_tool_call']) }).strict();
export const agentMessageSchema = z.object({ id: z.string().min(1), session_id: ConversationSessionIdSchema, role: messageRoleSchema, kind: messageKindSchema, content: z.string(), round_id: z.string().regex(roundIdGrammar), message_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), block_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), tool: z.string().optional(), tool_call_id: z.string().optional(), timestamp: z.string().datetime(), links: z.array(entityLinkSchema).optional(), model_spec: z.string().optional(), requested_model_spec: z.string().optional(), provider_projection: providerProjectionSchema.optional() }).strict().superRefine((message, ctx) => {
  if (message.kind === 'context_compaction') {
    if (message.role !== 'system') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'context_compaction rows must use system role', path: ['role'] });
    try { parseCanonicalContextCompaction(message.content); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ['content'] }); }
  }
  if (message.provider_projection) {
    if (message.role !== 'assistant' || (message.kind !== 'text' && message.kind !== 'tool_call')) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider_projection is allowed only on assistant text/tool_call rows', path: ['provider_projection'] });
    if (message.provider_projection.projection_kind === 'assistant_message' && message.kind !== 'text') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'assistant_message provider_projection requires a text row', path: ['provider_projection', 'projection_kind'] });
    if (message.provider_projection.projection_kind === 'assistant_tool_call' && message.kind !== 'tool_call') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'assistant_tool_call provider_projection requires a tool_call row', path: ['provider_projection', 'projection_kind'] });
  }
  if (message.kind === 'provider_private') {
    if (message.role !== 'system') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider_private rows must use system role', path: ['role'] });
    if (message.provider_projection) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'provider_private rows must not carry provider_projection', path: ['provider_projection'] });
  }
  if ((message.kind === 'tool_call' || message.kind === 'tool_result') && message.tool_call_id !== undefined && typeof message.tool_call_id !== 'string') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'tool_call_id must be a scalar string when present on tool entries', path: ['tool_call_id'] });
  if (message.kind !== 'tool_call' && message.kind !== 'tool_result') return;
  if (!message.tool) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${message.kind} rows require tool`, path: ['tool'] });
  if (!message.tool_call_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${message.kind} rows require tool_call_id`, path: ['tool_call_id'] });
    return;
  }
  try {
    const sourceInputId = message.kind === 'tool_call'
      ? sourceInputIdFromToolCallMessageId(message.id, message.tool_call_id)
      : sourceInputIdFromToolResultMessageId(message.id, message.tool_call_id);
    z.string().uuid().parse(sourceInputId);
  } catch (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ['id'] });
  }
});

export const runtimeStatusSchema = z.enum(['stopped', 'starting', 'running', 'pausing', 'paused', 'closing', 'error']);
export const runtimeStateSchema = z.object({ status: runtimeStatusSchema, project_id: z.literal('project'), pid: z.number().int().positive(), started_at: z.string().datetime(), current_card_id: cardIdSchema, updated_at: z.string().datetime() }).strict();
export const skillTargetAgentSchema = agentNameSchema;
const skillFileSchema = z.string().min(1).superRefine((file, ctx) => {
  const segments = file.split('/');
  const isAbsolute = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\');
  if (isAbsolute || file.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Skill file must be a normalized relative path without empty, dot, or parent segments.' });
  }
});
export const skillIndexEntrySchema: z.ZodType<import('./types.js').SkillIndexEntry> = z.object({
  name: z.string().min(1),
  file: skillFileSchema,
  target_agents: z.array(skillTargetAgentSchema).min(1).superRefine((roles, ctx) => {
    if (new Set(roles).size !== roles.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Skill target roles must be unique.' });
  }),
}).strict();
export const skillIndexSchema = z.array(skillIndexEntrySchema).superRefine((entries, ctx) => {
  const seen = new Set<string>();
  entries.forEach((entry, index) => {
    if (seen.has(entry.name)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Duplicate skill name '${entry.name}'.`, path: [index, 'name'] });
    seen.add(entry.name);
  });
});


export const runtimeEventKindSchema = enumFromCatalog(runtimeEventKindValues);
export const agentEventKindSchema = enumFromCatalog(agentEventKindValues);
export const eventKindSchema = enumFromCatalog(eventKindValues);

export { loggedEventSchema, loggedEventSchemaByKind };

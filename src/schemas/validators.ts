import { z } from 'zod';

import { sha256Hex } from './sha256.js';
import {
  cardActionValues,
  cardStatusValues,
  urgencyValues,
} from './types.js';
import { roundIdGrammar } from './round-id.js';
import { cardLifecycleStateSchema } from './lifecycle.js';
import { sourceInputIdFromToolCallMessageId, sourceInputIdFromToolResultMessageId } from './message-identity.js';
import { cardIdSchema, cardParentId } from './card-id.js';
import { agentNameSchema } from './agent-name.js';
import { cardTypeNameSchema } from './card-type-name.js';
import { ConversationSessionIdSchema } from './conversation-session-id.js';
import { CONTENT_POLICY_RETRY_TEXT, parseCanonicalContentPolicyRefusal } from './content-policy.js';
import { canonicalJson } from './canonical-json.js';
import { rowContextPolicySchema, type StructuralRowBehavior } from './context-policy.js';
export { nonRootCardIdSchema } from './card-id.js';
export { cardIdSchema };
export const cardTypeSchema = cardTypeNameSchema;
export const cardStatusSchema = z.enum(cardStatusValues);
export const cardActionSchema = z.enum(cardActionValues);
export const positiveSafeIntegerSchema = z.number().int().safe().positive();
export const urgencySchema = z.enum(urgencyValues);
const createdBySchema = z.union([agentNameSchema,z.literal('runtime:bootstrap')]);
const noteAuthorSchema = z.union([z.literal('user'),z.literal('runtime'),agentNameSchema]);
const controlActionSurfaceSchema = z.enum(['web-chat', 'rest', 'cli', 'runtime', 'web-ui']);
export const cardNotificationSchema: z.ZodType<import('./types.js').CardNotification> = z.object({ id: z.string().min(1), content: z.string().min(1), created_at: z.string().datetime(), source: z.string().min(1).optional() }).strict();
const cardRecordShape = { id: cardIdSchema, type: cardTypeSchema, child_membership: z.array(cardIdSchema), active_child_order: z.array(cardIdSchema), title: z.string().min(1), lifecycle: cardLifecycleStateSchema, subtype: z.null(), priority: z.number().int(), urgency: urgencySchema, created_by: createdBySchema, created_at: z.string().datetime(), updated_at: z.string().datetime(), version_seq: positiveSafeIntegerSchema, assigned_to: z.null(), depends_on: z.array(cardIdSchema), metrics: z.null(), estimate: z.null(), started_at: z.null(), duration_ms: z.null(), status_text: z.string().nullable(), status_text_updated_at: z.string().datetime().nullable(), status_text_author_session_id: z.null(), latest_self_report: z.null(), metadata: z.null(), pending_notifications: z.array(cardNotificationSchema) };
const { pending_notifications: _pendingNotificationsSchema, ...outboundCardRecordShape } = cardRecordShape;
function refineCardCommon(card: import('./types.js').OutboundCardRecord, ctx: z.RefinementCtx): void {
  if (card.id === 'project' && card.type !== 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'The project card is the fixed root.', path: ['id'] });
  if (card.id !== 'project' && card.type === 'project') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Only the fixed project card may have type project.', path: ['type'] });
  for (const field of ['child_membership', 'active_child_order'] as const) {
    const ids = card[field];
    if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Card ${field} must be duplicate-free.`, path: [field] });
    if (ids.some((id) => cardParentId(id) !== card.id)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Card ${field} must contain only direct child ids.`, path: [field] });
  }
  if (card.child_membership.length !== card.active_child_order.length || card.child_membership.some((id) => !card.active_child_order.includes(id))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Card child_membership and active_child_order must contain the same ids.', path: ['active_child_order'] });
}
function refineCardLifecycle(card: import('./types.js').CardRecord, ctx: z.RefinementCtx): void {
  refineCardCommon(card, ctx);
  if (new Set(card.pending_notifications.map((notification) => notification.id)).size !== card.pending_notifications.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Notification ids must be unique per card.', path: ['pending_notifications'] });
  if ((card.lifecycle.status === 'done' || card.lifecycle.status === 'failed' || card.lifecycle.status === 'cancelled') && card.pending_notifications.length !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Cards in status '${card.lifecycle.status}' require empty pending_notifications.`, path: ['pending_notifications'] });
}
export const outboundCardRecordSchema: z.ZodType<import('./types.js').OutboundCardRecord> = z.object(outboundCardRecordShape).strict().superRefine(refineCardCommon);
export const cardRecordSchema: z.ZodType<import('./types.js').CardRecord> = z.lazy(() => z.object(cardRecordShape).strict().superRefine(refineCardLifecycle));
export const cardViewSchema: z.ZodType<import('./types.js').CardView> = z.object({
  card: outboundCardRecordSchema,
  logical_path: z.string().nullable(),
  status: cardStatusSchema,
  parent: cardIdSchema.nullable(),
  operator_summary: z.object({ blocked: z.boolean(), hasError: z.boolean(), error: z.string().nullable(), completedAt: z.string().datetime().nullable(), stale: z.boolean() }).strict(),
}).strict();
export const controlActionAuditEntrySchema: z.ZodType<import('./types.js').ControlActionAuditEntry> = z.object({ id: z.string().min(1), actor: noteAuthorSchema, surface: controlActionSurfaceSchema, action: z.string().min(1), target_kind: z.enum(['card', 'note', 'process', 'runtime', 'config', 'session']).nullable(), target_id: z.string().nullable(), params_summary: z.string(), safety_class: z.enum(['read_only', 'low', 'high', 'destructive', 'deployment']).optional(), outcome: z.enum(['ok', 'error', 'denied']), outcome_summary: z.string(), error: z.string().optional(), created_at: z.string().datetime() }).strict();
export const projectConfigSchema = z.object({ id: z.literal('project'), name: z.string().min(1), context: z.string(), goals_summary: z.string(), constraints: z.array(z.string()), planner_enabled: z.boolean(), created_at: z.string().datetime(), updated_at: z.string().datetime() });
export const processStatusSchema = z.enum(['running', 'exited', 'failed', 'killed']);
const messageRoleSchema = z.enum(['user', 'assistant', 'system', 'tool']);
const messageKindSchema = z.enum(['text', 'activity', 'tool_call', 'tool_result', 'model_issue', 'model_repair', 'content_policy_retry', 'content_policy_refusal', 'model_recovered', 'provider_private']);
const entityLinkSchema = z.object({ entity_type: z.enum(['card', 'process', 'artifact', 'attachment']), entity_id: z.string().min(1), label: z.string().optional() }).strict();
const providerProjectionSchema = z.object({ kind: z.literal('openai_responses'), source_input_id: z.string().uuid(), private_message_id: z.string().min(1), projection_kind: z.enum(['assistant_message', 'assistant_tool_call']) }).strict();
export const agentMessageSchema = z.object({ id: z.string().min(1), session_id: ConversationSessionIdSchema, role: messageRoleSchema, kind: messageKindSchema, content: z.string(), context_policy: rowContextPolicySchema, round_id: z.string().regex(roundIdGrammar), message_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), block_index: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), tool: z.string().optional(), tool_call_id: z.string().optional(), timestamp: z.string().datetime(), links: z.array(entityLinkSchema).optional(), model_spec: z.string().optional(), requested_model_spec: z.string().optional(), provider_projection: providerProjectionSchema.optional() }).strict().superRefine((message, ctx) => {
  const policyIssue = (message: string, path: readonly (string | number)[] = ['context_policy']): void => ctx.addIssue({ code: z.ZodIssueCode.custom, message, path: [...path] });
  const structuralBehavior: StructuralRowBehavior | undefined = message.context_policy.kind === 'structural' ? message.context_policy.behavior : undefined;
  switch (message.kind) {
    case 'text': case 'model_repair': case 'content_policy_retry':
      if (message.context_policy.kind !== 'content') policyIssue(`'${message.kind}' rows require content policy.`);
      break;
    case 'activity':
      if (structuralBehavior !== 'activation_boundary') policyIssue("'activity' rows require structural activation_boundary policy.");
      break;
    case 'model_issue':
      if (structuralBehavior !== 'provider_failure') policyIssue("'model_issue' rows require structural provider_failure policy.");
      break;
    case 'content_policy_refusal':
      if (structuralBehavior !== 'content_policy_refusal') policyIssue("'content_policy_refusal' rows require structural content_policy_refusal policy.");
      break;
    case 'model_recovered':
      if (structuralBehavior !== 'model_recovery_notice') policyIssue("'model_recovered' rows require structural model_recovery_notice policy.");
      break;
    case 'provider_private':
      if (structuralBehavior !== 'responses_private') policyIssue("'provider_private' rows require structural responses_private policy.");
      break;
    case 'tool_call': {
      if (message.context_policy.kind !== 'tool_call') { policyIssue("'tool_call' rows require tool_call policy."); break; }
      const bytes = canonicalJson(message.context_policy.template);
      if (bytes !== message.context_policy.template_bytes) policyIssue('tool_call policy template bytes are not the canonical serialization of the template.', ['context_policy', 'template_bytes']);
      if (sha256Hex(bytes) !== message.context_policy.template_sha256) policyIssue('tool_call policy template sha256 does not commit to the template bytes.', ['context_policy', 'template_sha256']);
      break;
    }
    case 'tool_result': {
      if (message.context_policy.kind !== 'tool_result') { policyIssue("'tool_result' rows require tool_result policy."); break; }
      if (sha256Hex(message.content) !== message.context_policy.result_content_sha256) policyIssue('tool_result policy result hash does not commit to the exact settled content bytes.', ['context_policy', 'result_content_sha256']);
      let success: boolean;
      try { success = (JSON.parse(message.content) as { success?: unknown }).success === true; } catch { success = false; policyIssue('tool_result content must be the exact settled strict ToolResult bytes.', ['content']); break; }
      if (!success && message.context_policy.evidence.kind !== 'none') policyIssue('A failed tool_result must carry none evidence.', ['context_policy', 'evidence']);
      if (message.context_policy.settlement_origin !== 'executed' && success) policyIssue('A synthetic tool_result must be a failed provider result.', ['context_policy', 'settlement_origin']);
      if (message.context_policy.settlement_origin !== 'executed' && message.context_policy.evidence.kind !== 'none') policyIssue('A synthetic tool_result must carry none evidence.', ['context_policy', 'evidence']);
      break;
    }
  }
  if (message.context_policy.kind === 'content' && !message.context_policy.compactable) {
    if (
      message.role !== 'user' ||
      (message.kind !== 'text' && message.kind !== 'model_repair') ||
      message.context_policy.storage !== 'durable' ||
      message.context_policy.replacement.kind !== 'retain' ||
      message.context_policy.audience !== 'primary_and_summarizer' ||
      message.context_policy.evidence.kind !== 'none' ||
      message.provider_projection !== undefined
    ) policyIssue('Non-compactable content is allowed only for independent visible configured user text or model_repair rows.');
  }
  if (message.kind === 'content_policy_retry') {
    if (message.role !== 'user' || message.content !== CONTENT_POLICY_RETRY_TEXT) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content_policy_retry rows require the exact code-owned user message.', path: ['content'] });
    if (message.tool !== undefined || message.tool_call_id !== undefined || message.links !== undefined || message.provider_projection !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content_policy_retry rows forbid tool, link, and provider metadata.' });
  }
  if (message.kind === 'content_policy_refusal') {
    if (message.role !== 'system') ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content_policy_refusal rows must use system role', path: ['role'] });
    try { parseCanonicalContentPolicyRefusal(message.content); } catch (error) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: error instanceof Error ? error.message : String(error), path: ['content'] }); }
    if (message.tool !== undefined || message.tool_call_id !== undefined || message.links !== undefined || message.provider_projection !== undefined) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'content_policy_refusal rows forbid tool, link, and provider metadata.' });
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
const skillTargetAgentSchema = agentNameSchema;
const skillFileSchema = z.string().min(1).superRefine((file, ctx) => {
  const segments = file.split('/');
  const isAbsolute = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) || file.startsWith('\\\\');
  if (isAbsolute || file.includes('\\') || segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Skill file must be a normalized relative path without empty, dot, or parent segments.' });
  }
});
const skillIndexEntrySchema: z.ZodType<import('./types.js').SkillIndexEntry> = z.object({
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

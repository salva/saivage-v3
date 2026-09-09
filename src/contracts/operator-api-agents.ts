import { z } from 'zod';
import { providerExchangePayloadSchema } from './provider-exchange.js';
import {
  agentMessageSchema,
  agentNameSchema,
  cardIdSchema,
  ConversationSessionIdSchema,
  conversationSessionIdentity,
  positiveSafeIntegerSchema,
  requiredModelFactSlotsSchema,
  sha256HexSchema,
} from '../schemas/index.js';
import {
  operatorSessionContract,
  UnauthorizedErrorSchema,
  ValidationErrorSchema,
  UnexpectedInternalServerErrorSchema,
  type OperatorRouteContract,
} from './operator-api-core.js';
import { CardNotFoundErrorSchema } from './operator-api-runtime-cards.js';
import { ConversationHistoricalVersionNotFoundSchema } from './historical-version-not-found.js';

const AgentSessionParamsSchema = z.object({ id: ConversationSessionIdSchema }).strict();
const AgentConversationParamsSchema = AgentSessionParamsSchema;
const AgentLlmExchangeParamsSchema = AgentSessionParamsSchema;
const CardAgentSessionsParamsSchema = z.object({ id: cardIdSchema }).strict();
const AgentConversationQuerySchema = z
  .union([z.object({ segment_version: z.undefined().optional(), since: z.undefined().optional() }).strict(), z.object({ segment_version: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(positiveSafeIntegerSchema), since: z.string().min(1) }).strict()]);
const agentSessionBase = z
  .object({
    id: ConversationSessionIdSchema,
    agent_name: agentNameSchema,
    session_scope: z.enum(['global', 'card']),
    card_id: cardIdSchema.nullable(),
    started_at: z.string().datetime(),
    status: z.enum(['active', 'inactive']),
    activity: z.enum(['busy', 'idle']),
    compaction: z.object({
      strategy: z.enum(['preventive', 'authoritative_context_recovery', 'local_exact_admission']),
      started_at: z.string().datetime(),
      folds_done: z.number().int().safe().nonnegative(),
      fold_in_flight: z.boolean(),
    }).strict().nullable(),
  })
  .strict();
function requireMatchingIdentity(
  value: z.infer<typeof agentSessionBase>,
  ctx: z.RefinementCtx,
): void {
  const identity = conversationSessionIdentity(value.id);
  if (value.agent_name !== identity.agentName)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['agent_name'],
      message: 'Agent name must match session identity.',
    });
  if (value.card_id !== identity.cardId)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['card_id'],
      message: 'Card ownership must match session identity.',
    });
  if (value.session_scope !== (identity.cardId === null ? 'global' : 'card'))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['session_scope'],
      message: 'Session scope must match identity.',
    });
  if ((value.status === 'active') !== (value.activity === 'busy'))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['activity'],
      message: 'Agent session status and activity must be active/busy or inactive/idle.',
    });
  if (value.compaction !== null && value.status !== 'active')
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['compaction'],
      message: 'Compaction progress requires an active executing session.',
    });
}
export const AgentSessionSummarySchema = agentSessionBase.superRefine(requireMatchingIdentity);
export const AgentConversationEntrySchema = agentMessageSchema;
const continuationSchema = z.union([z.object({ kind: z.literal('between_rounds') }).strict(), z.object({ kind: z.literal('inherited_open_round'), activation: z.object({ marker_id: z.string().min(1), input_id: z.string().uuid() }).strict(), active_segment_kind: z.enum(['initial','repair']) }).strict()]);
export const ConversationSegmentContextSchema = z.object({ kind: z.literal('compacted'), source_version: positiveSafeIntegerSchema, covered_through_message_id: z.string().min(1), summary_text: z.string().min(1), source_kind: z.enum(['current_rows','prior_genesis_plus_current_rows']), prior_genesis_id: z.string().uuid().nullable(), prior_history_hash: sha256HexSchema.nullable(), covered_group_count: positiveSafeIntegerSchema, dispositions: z.object({ sha256: sha256HexSchema, count: positiveSafeIntegerSchema, summarized: z.number().int().safe().nonnegative(), evidence_only: z.number().int().safe().nonnegative(), superseded: z.number().int().safe().nonnegative() }).strict(), coverage: z.object({ source_session_id: z.string().min(1), source_version: positiveSafeIntegerSchema, covered_through_message_id: z.string().min(1), covered_source_groups_sha256: sha256HexSchema, accumulated_summary_sha256: sha256HexSchema }).strict(), required_model_facts: requiredModelFactSlotsSchema, continuation: continuationSchema }).strict().nullable();
export const AgentListResponseSchema = z
  .object({
    sessions: z.array(AgentSessionSummarySchema),
  })
  .strict()
  .superRefine(requireUniqueSortedSessions);
export const CardAgentSessionsResponseSchema = z
  .object({
    card_id: cardIdSchema,
    sessions: z.array(AgentSessionSummarySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    requireUniqueSortedSessions({ sessions: value.sessions }, ctx);
    for (const [index, session] of value.sessions.entries())
      if (session.card_id !== value.card_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sessions', index, 'card_id'],
          message: 'Session must belong to the requested card.',
        });
  });
const AgentSessionDetailSchema = AgentSessionSummarySchema;
export const AgentDetailResponseSchema = z
  .object({
    session: AgentSessionDetailSchema,
  })
  .strict();
export const AgentConversationResponseSchema = z
  .object({
    session_id: ConversationSessionIdSchema,
    segment_version: positiveSafeIntegerSchema,
    segment_context: ConversationSegmentContextSchema,
    entries: z.array(AgentConversationEntrySchema),
    cursor: z.object({ segment_version: positiveSafeIntegerSchema, message_id: z.string().min(1).nullable() }).strict(),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const [index, entry] of value.entries.entries())
      if (entry.session_id !== value.session_id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['entries', index, 'session_id'],
          message: 'Conversation entry session must match the enclosing session.',
        });
  });
export const AgentLlmExchangeResponseSchema = z
  .object({
    session_id: ConversationSessionIdSchema,
    exchange: providerExchangePayloadSchema,
  })
  .strict();
const AgentSessionNotFoundErrorSchema = z.object({
  error: z.literal('Agent session not found'),
}).strict();
const AgentLlmExchangeNotFoundErrorSchema = z.object({
  error: z.literal('No LLM exchange recorded for this session yet.'),
}).strict();
const AgentConversationCursorNotFoundErrorSchema = z.object({
  error: z.literal('conversation_cursor_not_found'), session_id: ConversationSessionIdSchema, segment_version: positiveSafeIntegerSchema, since: z.string().min(1),
}).strict();
const ConversationSegmentChangedErrorSchema = z.object({ error: z.literal('conversation_segment_changed'), session_id: ConversationSessionIdSchema, requested_segment_version: positiveSafeIntegerSchema, current_segment_version: positiveSafeIntegerSchema }).strict();
const ConversationVersionMetadataSchema = z.object({ entry_id: z.string().uuid(), version: positiveSafeIntegerSchema, published_at: z.string().datetime(), genesis_kind: z.enum(['ordinary','compacted']), source_version: positiveSafeIntegerSchema.nullable() }).strict();
export const ConversationVersionListResponseSchema = z.object({ session_id: ConversationSessionIdSchema, versions: z.array(ConversationVersionMetadataSchema), total: z.number().int().safe().nonnegative() }).strict().superRefine((value, ctx) => {
  if (value.total !== value.versions.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['total'], message: 'Conversation version total must equal the catalog length.' });
  value.versions.forEach((entry, index) => {
    if (entry.version !== index + 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index, 'version'], message: 'Conversation versions must be contiguous.' });
    if ((entry.genesis_kind === 'ordinary') !== (entry.version === 1) || (entry.source_version === null) !== (entry.genesis_kind === 'ordinary') || (entry.source_version !== null && entry.source_version !== entry.version - 1)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versions', index], message: 'Conversation version genesis metadata is inconsistent.' });
  });
});
const ConversationVersionParamsSchema = z.object({ id: ConversationSessionIdSchema, version: z.string().regex(/^[1-9][0-9]*$/).transform(Number).pipe(positiveSafeIntegerSchema) }).strict();
export const ConversationVersionContentResponseSchema = z.object({ session_id: ConversationSessionIdSchema, version: positiveSafeIntegerSchema, entry_id: z.string().uuid(), published_at: z.string().datetime(), segment_context: ConversationSegmentContextSchema, entries: z.array(AgentConversationEntrySchema) }).strict().superRefine((value, ctx) => {
  value.entries.forEach((entry, index) => { if (entry.session_id !== value.session_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['entries', index, 'session_id'], message: 'Conversation entry session must match the enclosing session.' }); });
  if ((value.version === 1) !== (value.segment_context === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['segment_context'], message: 'Conversation segment context must match the selected version.' });
});
const ConversationHistoricalUnavailableSchema = z.object({ error: z.literal('historical_version_content_unavailable'), resource: z.literal('conversation'), owner_id: ConversationSessionIdSchema, version: positiveSafeIntegerSchema, reason: z.enum(['missing','corrupt','io_error']) }).strict();
export const CurrentStateUnavailableSchema = z.object({ error: z.literal('current_state_unavailable'), resource: z.enum(['card', 'authored_record', 'conversation', 'provider_exchange_log']), owner_id: z.string().min(1), restart_required: z.literal(true) }).strict();
const AgentConversationBadRequestSchema = z.union([
  ValidationErrorSchema,
  AgentConversationCursorNotFoundErrorSchema,
]);

export type AgentSessionSummary = z.infer<typeof AgentSessionSummarySchema>;
export type AgentConversationEntry = z.infer<typeof AgentConversationEntrySchema>;
export type ConversationSegmentContext = z.infer<typeof ConversationSegmentContextSchema>;
export const agentOperatorApiContracts = {
  'agents.list': {
    operationId: 'agents.list',
    method: 'GET',
    path: '/api/agents',
    success: AgentListResponseSchema,
    response: {
      200: AgentListResponseSchema,
      401: UnauthorizedErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    ...operatorSessionContract,
  },
  'agents.detail': {
    operationId: 'agents.detail',
    method: 'GET',
    path: '/api/agents/:id',
    params: AgentSessionParamsSchema,
    success: AgentDetailResponseSchema,
    response: {
      200: AgentDetailResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      404: AgentSessionNotFoundErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
  },
  'agents.conversationVersions.list': { operationId: 'agents.conversationVersions.list', method: 'GET', path: '/api/agents/:id/conversation/versions', params: AgentConversationParamsSchema, success: ConversationVersionListResponseSchema, response: { 200: ConversationVersionListResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: AgentSessionNotFoundErrorSchema, 503: CurrentStateUnavailableSchema, 500: UnexpectedInternalServerErrorSchema }, failureIdentity: { kind: 'session', parameter: 'id' }, ...operatorSessionContract },
  'agents.conversationVersions.get': { operationId: 'agents.conversationVersions.get', method: 'GET', path: '/api/agents/:id/conversation/versions/:version', params: ConversationVersionParamsSchema, success: ConversationVersionContentResponseSchema, response: { 200: ConversationVersionContentResponseSchema, 400: ValidationErrorSchema, 401: UnauthorizedErrorSchema, 404: z.union([AgentSessionNotFoundErrorSchema, ConversationHistoricalVersionNotFoundSchema, ConversationHistoricalUnavailableSchema]), 409: ConversationHistoricalUnavailableSchema, 503: z.union([CurrentStateUnavailableSchema, ConversationHistoricalUnavailableSchema]), 500: UnexpectedInternalServerErrorSchema }, failureIdentity: { kind: 'session', parameter: 'id' }, ...operatorSessionContract },
  'agents.cardSessions': {
    operationId: 'agents.cardSessions',
    method: 'GET',
    path: '/api/cards/:id/agent-sessions',
    params: CardAgentSessionsParamsSchema,
    success: CardAgentSessionsResponseSchema,
    response: {
      200: CardAgentSessionsResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      404: CardNotFoundErrorSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'card', parameter: 'id' },
    ...operatorSessionContract,
  },
  'agents.conversation': {
    operationId: 'agents.conversation',
    method: 'GET',
    path: '/api/agents/:id/conversation',
    params: AgentConversationParamsSchema,
    query: AgentConversationQuerySchema,
    success: AgentConversationResponseSchema,
    response: {
      200: AgentConversationResponseSchema,
      400: AgentConversationBadRequestSchema,
      401: UnauthorizedErrorSchema,
      404: AgentSessionNotFoundErrorSchema,
      409: ConversationSegmentChangedErrorSchema,
      503: CurrentStateUnavailableSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
  },
  'agents.llmExchange': {
    operationId: 'agents.llmExchange',
    method: 'GET',
    path: '/api/agents/:id/llm-exchange',
    params: AgentLlmExchangeParamsSchema,
    success: AgentLlmExchangeResponseSchema,
    response: {
      200: AgentLlmExchangeResponseSchema,
      400: ValidationErrorSchema,
      401: UnauthorizedErrorSchema,
      404: z.union([AgentLlmExchangeNotFoundErrorSchema, AgentSessionNotFoundErrorSchema]),
      503: CurrentStateUnavailableSchema,
      500: UnexpectedInternalServerErrorSchema,
    },
    failureIdentity: { kind: 'session', parameter: 'id' },
    ...operatorSessionContract,
  },
} as const satisfies Record<string, OperatorRouteContract>;

function requireUniqueSortedSessions(
  value: { sessions: readonly z.infer<typeof AgentSessionSummarySchema>[] },
  ctx: z.RefinementCtx,
): void {
  const ids = value.sessions.map((session) => session.id);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessions'],
      message: 'Session ids must be unique.',
    });
  if (ids.some((id, index) => index > 0 && ids[index - 1]!.localeCompare(id) > 0))
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['sessions'],
      message: 'Sessions must be sorted by id.',
    });
}

import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { z } from 'zod';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { defineToolBinder, type ToolBinder } from './invocation.js';
import {
  reconfigureParamsSchema,
  type ReconfigureParams,
} from '../config/reconfigure-contract.js';
import type { ConfigMutation } from '../config/resolved-config-authority.js';
import { redactForOutbound } from '../redaction/index.js';
import type { McpReconcileResult } from '../contracts/mcp-invocation.js';
import {
  queueNotificationInputSchema,
  readAgentSessionInputSchema,
} from '../contracts/builtin-tool-inputs.js';
import {
  AgentConversationEntrySchema,
  ConversationSegmentContextSchema,
  AgentSessionSummarySchema,
} from '../contracts/operator-api-agents.js';
import { AgentCurrentStateUnavailableError, AgentSessionNotFoundError } from '../application/read-models/agent-operator-read-model.js';

const JSONL_TAIL_DEFAULT = 50;
export const ListAgentSessionsToolDataSchema = z
  .object({ sessions: z.array(AgentSessionSummarySchema) })
  .strict();
export const ReadAgentSessionToolDataSchema = z
  .object({
    session: AgentSessionSummarySchema,
    ownership: z.enum(['active', 'retained_tombstone']),
    segment_version: z.number().int().positive(),
    segment_context: ConversationSegmentContextSchema,
    total_visible_entries: z.number().int().nonnegative(),
    returned_visible_entries: z.number().int().nonnegative(),
    messages: z.array(AgentConversationEntrySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.returned_visible_entries !== value.messages.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returned'],
        message: 'Returned must equal messages length.',
      });
    if (value.total_visible_entries < value.returned_visible_entries)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['total_messages'],
        message: 'Total messages cannot be smaller than returned.',
      });
    for (const [index, message] of value.messages.entries())
      if (message.session_id !== value.session.id)
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['messages', index, 'session_id'],
          message: 'Message belongs to a foreign session.',
        });
  });
const toolFailureSchema = z
  .object({ success: z.literal(false), error: z.string().min(1) })
  .strict();
export const ListAgentSessionsToolResultSchema = z.union([
  z.object({ success: z.literal(true), data: ListAgentSessionsToolDataSchema }).strict(),
  toolFailureSchema,
]);
export const ReadAgentSessionToolResultSchema = z.union([
  z.object({ success: z.literal(true), data: ReadAgentSessionToolDataSchema }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Agent session not found.'), data: z.object({ code: z.literal('agent_session_not_found'), session_id: z.string().min(1) }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Agent session has no current conversation segment.'), data: z.object({ code: z.literal('agent_session_empty'), session_id: z.string().min(1) }).strict() }).strict(),
  z.object({ success: z.literal(false), error: z.literal('Current Agent session state unavailable; restart required.'), data: z.object({ code: z.literal('current_state_unavailable'), resource: z.enum(['card', 'conversation']), owner_id: z.string().min(1), restart_required: z.literal(true) }).strict() }).strict(),
]);

export async function queue_notification(
  ctx: ToolContext,
  params: { card_id: string; kind: string; body: string },
  signal?: AbortSignal,
): Promise<ToolResult> {
  return runAuditedAnalystTool(
    ctx,
    params,
    {
      action: 'notification.queue',
      safety_class: 'low',
      target_kind: 'card',
      getTargetId: () => params.card_id,
      lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
      mutate: (_prepared, input, mutation) =>
        mutation.services.notifications.queue(input.card_id, input.kind, input.body),
    },
    signal,
  );
}

export async function show_config(
  ctx: ToolContext,
  _params: Record<string, never> = {},
): Promise<ToolResult> {
  try {
    const result = ctx.configAuthority.loadEffective();
    return {
      success: true,
      data: { config: redactForOutbound({ source: 'config', value: result.config }) },
    };
  } catch (err) {
    return toolFailureFromError(err);
  }
}

export async function reconfigure(
  ctx: ToolContext,
  params: ReconfigureParams,
  signal?: AbortSignal,
): Promise<ToolResult> {
  const actionName = `reconfigure.${params.action}`;
  return runAuditedAnalystTool(
    ctx,
    params as ReconfigureParams & Record<string, unknown>,
    {
      action: actionName,
      safety_class: 'low',
      target_kind: 'config',
      getTargetId: () => targetId(params),
      lifecycle: { kind: 'intervention_ready', timing: 'immediate_before_mutation' },
      mutate: (_prepared, input, mutation) => {
        const change = reconfigureMutation(input);
        return mutation.services.config.apply(change);
      },
    },
    signal,
  );
}

function reconfigureMutation(input: ReconfigureParams): ConfigMutation {
  switch (input.action) {
    case 'set_agent_model_route':
      return { kind: 'set_agent_model_route', agent: input.agent, modelRoute: input.model_route };
    case 'set_model_failover':
      return {
        kind: 'set_model_failover',
        forModel: input.for_model,
        orderedFailoverModels: input.ordered_failover_models,
      };
    case 'set_server_setting':
      switch (input.key) {
        case 'port':
          return { kind: 'set_server_setting', key: input.key, value: input.value };
        case 'host':
          return { kind: 'set_server_setting', key: input.key, value: input.value };
      }
  }
}

function targetId(input: ReconfigureParams): string {
  switch (input.action) {
    case 'set_agent_model_route':
      return input.agent;
    case 'set_model_failover':
      return input.for_model;
    case 'set_server_setting':
      return input.key;
  }
}

export async function mcp_reconcile(
  ctx: ToolContext,
  _params: Record<string, never> = {},
): Promise<McpReconcileResult> {
  return {
    success: false,
    error: 'MCP reconciliation is unavailable until quiescent Pause is introduced.',
    data: { persisted: false, reconciled: false },
  };
}

export async function list_agent_sessions(
  ctx: ToolContext,
  _params: Record<string, never>,
): Promise<ToolResult> {
  try {
    const sessions = new AgentOperatorReadModelService(
      ctx.projectRoot,
      ctx.store.workflows,
      ctx.captureExecutingLlmSessionIds,
    ).listSessions().sessions;
    return ListAgentSessionsToolResultSchema.parse({ success: true, data: { sessions } });
  } catch (err) {
    return ListAgentSessionsToolResultSchema.parse(toolFailureFromError(err));
  }
}

export async function read_agent_session(
  ctx: ToolContext,
  params: z.infer<typeof readAgentSessionInputSchema>,
): Promise<ToolResult> {
  try {
    const parsed = readAgentSessionInputSchema.parse(params);
    const sessionId = parsed.session_id;
    const limit = parsed.last_n ?? JSONL_TAIL_DEFAULT;
    const service = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store.workflows, ctx.captureExecutingLlmSessionIds);
    const response = service.readCurrentSegmentTail(sessionId, limit);
    if (response.kind === 'empty') return ReadAgentSessionToolResultSchema.parse({ success: false, error: 'Agent session has no current conversation segment.', data: { code: 'agent_session_empty', session_id: sessionId } });
    const conversation = response.conversation;
    return ReadAgentSessionToolResultSchema.parse({
      success: true,
      data: {
        session: response.session,
        ownership: response.ownership,
        segment_version: conversation.segmentVersion,
        segment_context: conversation.segmentContext,
        total_visible_entries: conversation.totalEntries,
        returned_visible_entries: conversation.entries.length,
        messages: conversation.entries,
      },
    });
  } catch (err) {
    if (err instanceof AgentSessionNotFoundError) return ReadAgentSessionToolResultSchema.parse({ success: false, error: 'Agent session not found.', data: { code: 'agent_session_not_found', session_id: params.session_id } });
    if (err instanceof AgentCurrentStateUnavailableError) return ReadAgentSessionToolResultSchema.parse({ success: false, error: 'Current Agent session state unavailable; restart required.', data: { code: 'current_state_unavailable', resource: err.resource, owner_id: err.ownerId, restart_required: true } });
    throw err;
  }
}

export const analystMiscToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
    defineToolBinder({
      name: 'queue_notification',
      description:
        'Queue operator context on a notification-capable card for its planner or executor.',
      inputSchema: queueNotificationInputSchema,
      executor: (ctx, args, signal) => queue_notification(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'show_config',
      description: 'Show the current project configuration with secrets redacted.',
      inputSchema: emptyInput,
      executor: (ctx, args) => show_config(ctx, args),
    }),
    defineToolBinder({
      name: 'reconfigure',
      description:
        'Replace one named-agent model route, model failover chain, or server host/port in the next-start configuration. Every successful mutation requires restart.',
      inputSchema: reconfigureParamsSchema,
      executor: (ctx, args, signal) => reconfigure(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'mcp_reconcile',
      description:
        'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.',
      inputSchema: emptyInput,
      executor: (ctx, args) => mcp_reconcile(ctx, args),
    }),
    defineToolBinder({
      name: 'list_agent_sessions',
      description: 'List authoritative durable global and active-card agent session summaries.',
      inputSchema: emptyInput,
      executor: (ctx, args) => list_agent_sessions(ctx, args),
    }),
    defineToolBinder({
      name: 'read_agent_session',
      description:
        'Read a canonical agent session summary and its most recent persisted conversation entries.',
      inputSchema: readAgentSessionInputSchema,
      executor: (ctx, args) => read_agent_session(ctx, args),
    }),
]);

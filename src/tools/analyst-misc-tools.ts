import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { z } from 'zod';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { AnalystToolOutcome, ToolContext } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder, type ToolExecutionResult } from './invocation.js';
import {
  reconfigureParamsSchema,
  type ReconfigureParams,
} from '../config/reconfigure-contract.js';
import type { ConfigMutation } from '../config/resolved-config-authority.js';
import { redactForOutbound } from '../redaction/index.js';
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
import { toolFailed, toolSucceeded } from '../contracts/tool-result.js';

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

async function queue_notification(
  ctx: ToolContext,
  params: { card_id: string; kind: string; body: string },
  signal?: AbortSignal,
): Promise<ToolExecutionResult<'none'>> {
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
): Promise<AnalystToolOutcome> {
  try {
    const result = ctx.configAuthority.loadEffective();
    return toolSucceeded({ config: redactForOutbound({ source: 'config', value: result.config }) });
  } catch (err) {
    return toolFailureFromError(err);
  }
}

async function reconfigure(
  ctx: ToolContext,
  params: ReconfigureParams,
  signal?: AbortSignal,
): Promise<ToolExecutionResult<'none'>> {
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

async function mcp_reconcile(
  ctx: ToolContext,
  _params: Record<string, never> = {},
): Promise<AnalystToolOutcome> {
  return toolFailed('MCP reconciliation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
}

export async function list_agent_sessions(
  ctx: ToolContext,
  _params: Record<string, never>,
): Promise<AnalystToolOutcome> {
  try {
    const sessions = new AgentOperatorReadModelService(
      ctx.projectRoot,
      ctx.store.workflows,
      ctx.captureExecutingLlmSnapshots,
    ).listSessions().sessions;
    return toolSucceeded(ListAgentSessionsToolDataSchema.parse({ sessions }));
  } catch (err) {
    return toolFailureFromError(err);
  }
}

export async function read_agent_session(
  ctx: ToolContext,
  params: z.infer<typeof readAgentSessionInputSchema>,
): Promise<AnalystToolOutcome> {
  try {
    const parsed = readAgentSessionInputSchema.parse(params);
    const sessionId = parsed.session_id;
    const limit = parsed.last_n ?? JSONL_TAIL_DEFAULT;
    const service = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store.workflows, ctx.captureExecutingLlmSnapshots);
    const response = service.readCurrentSegmentTail(sessionId, limit);
    if (response.kind === 'empty') return toolFailed('Agent session has no current conversation segment.', { code: 'agent_session_empty', session_id: sessionId });
    const conversation = response.conversation;
    return toolSucceeded(ReadAgentSessionToolDataSchema.parse({
        session: response.session,
        ownership: response.ownership,
        segment_version: conversation.segmentVersion,
        segment_context: conversation.segmentContext,
        total_visible_entries: conversation.totalEntries,
        returned_visible_entries: conversation.entries.length,
        messages: conversation.entries,
      }));
  } catch (err) {
    if (err instanceof AgentSessionNotFoundError) return toolFailed('Agent session not found.', { code: 'agent_session_not_found', session_id: params.session_id });
    if (err instanceof AgentCurrentStateUnavailableError) return toolFailed('Current Agent session state unavailable; restart required.', { code: 'current_state_unavailable', resource: err.resource, owner_id: err.ownerId, restart_required: true });
    throw err;
  }
}

export const analystMiscToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
    defineToolBinder({
      name: 'queue_notification',
      description:
        "Queue context on a notification-capable card for its configured current/next workflow-node agent while notification admission is open. Pending delivery context is not readable.",
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => queueNotificationInputSchema,
      executor: (ctx, args, signal) => queue_notification(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'show_config',
      description: 'Show the current project configuration with secrets redacted.',
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => emptyInput,
      executor: (ctx, args) => executeToolAction('observational_query', () => show_config(ctx, args)),
    }),
    defineToolBinder({
      name: 'reconfigure',
      description:
        'Replace one named-agent model route, model failover chain, or server host/port in the next-start configuration. Every successful mutation requires restart.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => reconfigureParamsSchema,
      executor: (ctx, args, signal) => reconfigure(ctx, args, signal),
    }),
    defineToolBinder({
      name: 'mcp_reconcile',
      description:
        'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.',
      resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
      inputSchema: () => emptyInput,
      executor: (ctx, args) => executeToolAction('none', () => mcp_reconcile(ctx, args)),
    }),
    defineToolBinder({
      name: 'list_agent_sessions',
      description: 'List authoritative durable global and active-card agent session summaries.',
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => emptyInput,
      executor: (ctx, args) => executeToolAction('observational_query', () => list_agent_sessions(ctx, args)),
    }),
    defineToolBinder({
      name: 'read_agent_session',
      description:
        'Read a canonical agent session summary and its most recent persisted conversation entries.',
      resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
      inputSchema: () => readAgentSessionInputSchema,
      executor: (ctx, args) => executeToolAction('observational_query', () => read_agent_session(ctx, args)),
    }),
]);

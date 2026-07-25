import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { z } from 'zod';
import { parseConversationSessionId } from '../schemas/index.js';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolDefinition } from './invocation.js';
import {
  reconfigureParamsSchema,
  type ConfigMutation,
  type ReconfigureParams,
} from '../config/index.js';
import { redactForOutbound } from '../redaction/index.js';
import type { McpReconcileResult } from '../contracts/mcp-invocation.js';
import {
  queueNotificationInputSchema,
  readAgentSessionInputSchema,
} from '../contracts/builtin-tool-inputs.js';
import {
  AgentConversationEntrySchema,
  AgentSessionSummarySchema,
} from '../contracts/operator-api-agents.js';
import { AgentSessionNotFoundError } from '../application/read-models/agent-operator-read-model.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;
export const ListAgentSessionsToolDataSchema = z
  .object({ sessions: z.array(AgentSessionSummarySchema) })
  .strict();
export const ReadAgentSessionToolDataSchema = z
  .object({
    session: AgentSessionSummarySchema,
    total_messages: z.number().int().nonnegative(),
    returned: z.number().int().nonnegative(),
    messages: z.array(AgentConversationEntrySchema),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.returned !== value.messages.length)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['returned'],
        message: 'Returned must equal messages length.',
      });
    if (value.total_messages < value.returned)
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
  toolFailureSchema,
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
      lifecycle: 'intervention_ready',
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
      lifecycle: 'intervention_ready',
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
    ).listSessions().sessions;
    return ListAgentSessionsToolResultSchema.parse({ success: true, data: { sessions } });
  } catch (err) {
    return ListAgentSessionsToolResultSchema.parse(toolFailureFromError(err));
  }
}

export async function read_agent_session(
  ctx: ToolContext,
  params: { sessionId: string; lastN?: number },
): Promise<ToolResult> {
  try {
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0)
      return ReadAgentSessionToolResultSchema.parse({
        success: false,
        error: 'sessionId is required.',
      });
    let sessionId;
    try {
      sessionId = parseConversationSessionId(params.sessionId);
    } catch {
      return ReadAgentSessionToolResultSchema.parse({
        success: false,
        error: 'sessionId is not canonical.',
      });
    }
    const limit = Math.min(Math.max(1, params.lastN ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const service = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store.workflows);
    const detail = service.getSession(sessionId);
    const response = service.readBoundedConversation(sessionId, limit);
    return ReadAgentSessionToolResultSchema.parse({
      success: true,
      data: {
        session: detail.session,
        total_messages: response.totalEntries,
        returned: response.entries.length,
        messages: response.entries,
      },
    });
  } catch (err) {
    return ReadAgentSessionToolResultSchema.parse(
      toolFailureFromError(
        err instanceof AgentSessionNotFoundError
          ? new Error(`Agent session '${params.sessionId}' was not found.`)
          : err,
      ),
    );
  }
}

export function analystMiscTools(ctx: ToolContext): readonly ToolDefinition<any>[] {
  return [
    defineTool({
      name: 'queue_notification',
      description:
        'Queue operator context on a notification-capable card for its planner or executor.',
      inputSchema: queueNotificationInputSchema,
      executor: (args, signal) => queue_notification(ctx, args, signal),
    }),
    defineTool({
      name: 'show_config',
      description: 'Show the current project configuration with secrets redacted.',
      inputSchema: emptyInput,
      executor: (args) => show_config(ctx, args),
    }),
    defineTool({
      name: 'reconfigure',
      description:
        'Replace one named-agent model route, model failover chain, or server host/port in the next-start configuration. Every successful mutation requires restart.',
      inputSchema: reconfigureParamsSchema,
      executor: (args, signal) => reconfigure(ctx, args, signal),
    }),
    defineTool({
      name: 'mcp_reconcile',
      description:
        'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.',
      inputSchema: emptyInput,
      executor: (args) => mcp_reconcile(ctx, args),
    }),
    defineTool({
      name: 'list_agent_sessions',
      description: 'List authoritative durable global and active-card agent session summaries.',
      inputSchema: emptyInput,
      executor: (args) => list_agent_sessions(ctx, args),
    }),
    defineTool({
      name: 'read_agent_session',
      description:
        'Read a canonical agent session summary and its most recent persisted conversation entries.',
      inputSchema: readAgentSessionInputSchema,
      executor: (args) => read_agent_session(ctx, args),
    }),
  ];
}

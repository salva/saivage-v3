import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { parseConversationSessionId } from '../schemas/index.js';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolDefinition } from './invocation.js';
import { reconfigureParamsSchema, type ConfigMutation, type ReconfigureParams } from '../config/index.js';
import { redactForOutbound } from '../redaction/index.js';
import type { McpReconcileResult } from '../contracts/mcp-invocation.js';
import { queueNotificationInputSchema, readAgentSessionInputSchema } from '../contracts/builtin-tool-inputs.js';
import { projectBoundedAgentSessionWrapper } from '../application/read-models/canonical-conversation-outbound.js';
import { projectToolInvocation } from './tool-invocation-outbound.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

export async function queue_notification(ctx: ToolContext, params: { card_id: string; kind: string; body: string }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'notification.queue', safety_class: 'low', target_kind: 'card', getTargetId: () => params.card_id, lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => mutation.services.notifications.queue(input.card_id, input.kind, input.body) }, signal);
}

export async function show_config(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  try { const result = ctx.configAuthority.loadEffective(); return { success: true, data: { config: redactForOutbound({ source: 'config', value: result.config }) } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function reconfigure(ctx: ToolContext, params: ReconfigureParams, signal?: AbortSignal): Promise<ToolResult> {
  const actionName = `reconfigure.${params.action}`;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: 'config', getTargetId: () => targetId(params), lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => {
    const change = reconfigureMutation(input);
    return mutation.services.config.apply(change);
  } }, signal);
}

function reconfigureMutation(input: ReconfigureParams): ConfigMutation {
  switch (input.action) {
    case 'set_agent_model_route': return { kind: 'set_agent_model_route', agent: input.agent, modelRoute: input.model_route };
    case 'set_model_failover': return { kind: 'set_model_failover', forModel: input.for_model, orderedFailoverModels: input.ordered_failover_models };
    case 'set_server_setting':
      switch (input.key) {
        case 'port': return { kind: 'set_server_setting', key: input.key, value: input.value };
        case 'host': return { kind: 'set_server_setting', key: input.key, value: input.value };
      }
  }
}

function targetId(input: ReconfigureParams): string {
  switch (input.action) {
    case 'set_agent_model_route': return input.agent;
    case 'set_model_failover': return input.for_model;
    case 'set_server_setting': return input.key;
  }
}

export async function mcp_reconcile(ctx: ToolContext, _params: Record<string, never> = {}): Promise<McpReconcileResult> {
  return {
    success: false,
    error: 'MCP reconciliation is unavailable until quiescent Pause is introduced.',
    data: { persisted: false, reconciled: false },
  };
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try {
    const sessions = new AgentOperatorReadModelService(ctx.projectRoot, ctx.captureExecutingLlmSnapshots,ctx.store.workflows).listSessions().sessions;
    return { success: true, data: sessions };
  }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_agent_session(ctx: ToolContext, params: { sessionId: string; lastN?: number }): Promise<ToolResult> {
  try {
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) return toolFailure('sessionId is required.', { field: 'sessionId' });
    let sessionId;
    try { sessionId = parseConversationSessionId(params.sessionId); }
    catch { return toolFailure('sessionId is not canonical.', { field: 'sessionId' }); }
    const limit = Math.min(Math.max(1, params.lastN ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const response = new AgentOperatorReadModelService(ctx.projectRoot, ctx.captureExecutingLlmSnapshots,ctx.store.workflows).getConversation(sessionId);
    if (response.statusCode === 404) return toolFailure(`Agent session '${params.sessionId}' was not found.`, { sessionId: params.sessionId });
    if (response.statusCode) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId, statusCode: response.statusCode });
    if (!('entries' in response.body)) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId });
    const entries = response.body.entries.slice(-limit);
    const bounded = projectBoundedAgentSessionWrapper({
      session: response.body.session,
      activity_status: response.body.activity_status,
      total_messages: response.body.entries.length,
      returned: entries.length,
      parse_errors: 0,
      messages: entries,
    }, projectToolInvocation);
    return { success: true, data: bounded };
  }
  catch (err) { return toolFailureFromError(err); }
}

export function analystMiscTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'queue_notification', description: 'Queue operator context on a notification-capable card for its planner or executor.', inputSchema: queueNotificationInputSchema, executor: (args, signal) => queue_notification(ctx, args, signal) }),
  defineTool({ name: 'show_config', description: 'Show the current project configuration with secrets redacted.', inputSchema: emptyInput, executor: (args) => show_config(ctx, args) }),
  defineTool({ name: 'reconfigure', description: 'Replace one named-agent model route, model failover chain, or server host/port in the next-start configuration. Every successful mutation requires restart.', inputSchema: reconfigureParamsSchema, executor: (args, signal) => reconfigure(ctx, args, signal) }),
  defineTool({ name: 'mcp_reconcile', description: 'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.', inputSchema: emptyInput, executor: (args) => mcp_reconcile(ctx, args) }),
  defineTool({ name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', inputSchema: emptyInput, executor: (args) => list_agent_sessions(ctx, args) }),
  defineTool({ name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", inputSchema: readAgentSessionInputSchema, executor: (args) => read_agent_session(ctx, args) }),
]; }

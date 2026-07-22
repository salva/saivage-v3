import { z } from 'zod';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { GLOBAL_ANALYST_SESSION_ID, parseConversationSessionId } from '../schemas/index.js';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { cardIdSchema } from '../schemas/index.js';
import { defineTool, type ToolDefinition } from './invocation.js';
import { reconfigureParamsSchema, type ConfigMutation, type ReconfigureParams } from '../config/index.js';
import { redactForOutbound } from '../redaction/index.js';

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
  if (params.action === 'mcp_add' || params.action === 'mcp_edit' || params.action === 'mcp_remove') {
    return toolFailure('MCP desired-config mutation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
  }
  const actionName = `reconfigure.${params.action.replace(/^set_/, 'set_')}`;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: 'config', getTargetId: () => targetId(params), lifecycle: 'intervention_ready', mutate: (_prepared, input, mutation) => {
    const change = reconfigureMutation(input);
    return mutation.services.config.apply(change);
  } }, signal);
}

function reconfigureMutation(input: ReconfigureParams): ConfigMutation {
  switch (input.action) {
    case 'set_role_routing': return { kind: 'set_role_routing', role: input.role, modelCandidate: input.model_candidate };
    case 'set_failover_chain': return { kind: 'set_failover_chain', forModel: input.for_model, orderedFailoverModels: input.ordered_failover_models };
    case 'set_runtime_setting':
      switch (input.key) {
        case 'continuous_improvement': return { kind: 'set_runtime_setting', key: input.key, value: input.value };
        case 'process_timeouts': return { kind: 'set_runtime_setting', key: input.key, value: input.value };
      }
    case 'set_server_setting':
      switch (input.key) {
        case 'port': return { kind: 'set_server_setting', key: input.key, value: input.value };
        case 'host': return { kind: 'set_server_setting', key: input.key, value: input.value };
      }
    case 'mcp_add':
    case 'mcp_edit':
    case 'mcp_remove': throw new Error(`MCP action '${input.action}' must be rejected before config mutation.`);
  }
}

function targetId(input: ReconfigureParams): string {
  switch (input.action) {
    case 'set_role_routing': return input.role;
    case 'set_failover_chain': return input.for_model;
    case 'mcp_add':
    case 'mcp_edit':
    case 'mcp_remove': return input.name;
    case 'set_runtime_setting':
    case 'set_server_setting': return input.key;
  }
}

export async function mcp_reconcile(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  return toolFailure('MCP reconciliation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try {
    const sessions = new AgentOperatorReadModelService(ctx.projectRoot, ctx.captureExecutingLlmSnapshots).listSessions().sessions
      .filter((session) => session.role !== 'analyst' || session.id === GLOBAL_ANALYST_SESSION_ID);
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
    const response = new AgentOperatorReadModelService(ctx.projectRoot, ctx.captureExecutingLlmSnapshots).getConversation(sessionId);
    if (response.statusCode === 404) return toolFailure(`Agent session '${params.sessionId}' was not found.`, { sessionId: params.sessionId });
    if (response.statusCode) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId, statusCode: response.statusCode });
    if (!('entries' in response.body)) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId });
    const entries = response.body.entries.slice(-limit);
    return { success: true, data: { session: response.body.session, activity_status: response.body.activity_status, total_messages: response.body.entries.length, returned: entries.length, parse_errors: 0, messages: entries } };
  }
  catch (err) { return toolFailureFromError(err); }
}

export function analystMiscTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'queue_notification', description: 'Queue operator context on a notification-capable card for its planner or executor.', inputSchema: z.object({ card_id: describe(cardIdSchema, 'The exact card id.'), kind: describe(z.string().min(1), 'A short categorical label.'), body: describe(z.string().min(1), 'The context text to inject.') }).strict(), executor: (args, signal) => queue_notification(ctx, args, signal) }),
  defineTool({ name: 'show_config', description: 'Show the current project configuration with secrets redacted.', inputSchema: emptyInput, executor: (args) => show_config(ctx, args) }),
  defineTool({ name: 'reconfigure', description: 'Reconfigure role routing, failover, MCP servers, runtime, or server settings.', inputSchema: reconfigureParamsSchema, executor: (args, signal) => reconfigure(ctx, args, signal) }),
  defineTool({ name: 'mcp_reconcile', description: 'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.', inputSchema: emptyInput, executor: (args) => mcp_reconcile(ctx, args) }),
  defineTool({ name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', inputSchema: emptyInput, executor: (args) => list_agent_sessions(ctx, args) }),
  defineTool({ name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", inputSchema: z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict(), executor: (args) => read_agent_session(ctx, args) }),
]; }

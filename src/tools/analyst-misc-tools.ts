import { z } from 'zod';
import { redactAnalystSecretValue } from '../workspace/file-access-security.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { GLOBAL_ANALYST_SESSION_ID, parseConversationSessionId } from '../schemas/index.js';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { commitQueueNotification, commitReconfigure, recheckQueueNotification, recheckReconfigure } from '../application/analyst-mutation-operations.js';
import { cardIdSchema } from '../schemas/index.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

export async function queue_notification(ctx: ToolContext, params: { card_id: string; kind: string; body: string }, signal?: AbortSignal): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'notification.queue', safety_class: 'low', target_kind: 'card', getTargetId: () => params.card_id, lifecycle: 'intervention_ready', recheck: recheckQueueNotification, commit: commitQueueNotification }, signal);
}

export async function show_config(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  try { const result = ctx.configAuthority.loadEffective(); return { success: true, data: { config: redactAnalystSecretValue(result.config) } }; }
  catch (err) { return toolFailureFromError(err); }
}

type ReconfigureParams = { action: 'set_role_routing' | 'set_failover_chain' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; name?: string; command?: string; args?: string[]; env?: Record<string, string>; key?: string; value?: unknown };

export async function reconfigure(ctx: ToolContext, params: ReconfigureParams, signal?: AbortSignal): Promise<ToolResult> {
  if (params.action === 'mcp_add' || params.action === 'mcp_edit' || params.action === 'mcp_remove') {
    return toolFailure('MCP desired-config mutation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
  }
  const actionName = `reconfigure.${params.action.replace(/^set_/, 'set_')}`;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: 'config', getTargetId: () => params.name ?? params.role ?? params.key ?? params.action, lifecycle: 'intervention_ready', recheck: recheckReconfigure, commit: commitReconfigure }, signal);
}

export async function mcp_reconcile(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  return toolFailure('MCP reconciliation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try {
    const sessions = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store).listSessions().sessions
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
    const response = new AgentOperatorReadModelService(ctx.projectRoot, ctx.store).getConversation(sessionId);
    if (response.statusCode === 404) return toolFailure(`Agent session '${params.sessionId}' was not found.`, { sessionId: params.sessionId });
    if (response.statusCode) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId, statusCode: response.statusCode });
    if (!('entries' in response.body)) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId });
    const entries = response.body.entries.slice(-limit);
    return { success: true, data: { session: response.body.session, total_messages: response.body.entries.length, returned: entries.length, parse_errors: 0, messages: entries } };
  }
  catch (err) { return toolFailureFromError(err); }
}

export const analystMiscTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'queue_notification', description: 'Queue operator context on one nonterminal card for its planner or executor.', input: z.object({ card_id: describe(cardIdSchema, 'The exact card id.'), kind: describe(z.string().min(1), 'A short categorical label.'), body: describe(z.string().min(1), 'The context text to inject.') }).strict(), roles: ['analyst', 'planner'], executor: queue_notification },
  { name: 'show_config', description: 'Show the current project configuration with secrets redacted.', input: emptyInput, roles: ['analyst'], executor: show_config },
  { name: 'reconfigure', description: 'Reconfigure role routing, failover, MCP servers, runtime, or server settings.', input: z.object({ action: z.enum(['set_role_routing', 'set_failover_chain', 'mcp_add', 'mcp_edit', 'mcp_remove', 'set_runtime_setting', 'set_server_setting']), role: z.string().optional(), model_candidate: z.string().optional(), for_model: z.string().optional(), ordered_failover_models: z.array(z.string()).optional(), name: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), key: z.string().optional(), value: z.unknown().optional() }).strict(), roles: ['analyst'], executor: reconfigure },
  { name: 'mcp_reconcile', description: 'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.', input: emptyInput, roles: ['analyst'], executor: mcp_reconcile },
  { name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', input: emptyInput, roles: ['analyst'], executor: list_agent_sessions },
  { name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", input: z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_agent_session },
] as const;

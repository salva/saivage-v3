import { z } from 'zod';
import { queueNotification, resolveRecipient } from '../notifications/index.js';
import { redactAnalystSecretValue } from '../workspace/file-access-security.js';
import type { ConfigMutation } from '../config/index.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import { GLOBAL_ANALYST_SESSION_ID, isSafeAgentSessionId } from '../agents/session-ids.js';
import { AgentOperatorReadModelService } from '../application/read-models/index.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

export async function queue_notification(ctx: ToolContext, params: { recipient: string; kind: string; body: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, { recipient: params.recipient, kind: params.kind }, { action: 'notification.queue', safety_class: 'low', target_kind: 'session', getTargetId: () => params.recipient, lifecycle: 'intervention_ready', recheck: () => ({ allowed: true }), commit: () => {
    const resolved = resolveRecipient(ctx.projectRoot, ctx.store, params.recipient);
    if (resolved === null) return toolFailure(`Unknown notification recipient '${params.recipient}'.`, { reason: 'unknown_recipient', recipient: params.recipient });
    const queued = queueNotification(ctx.projectRoot, resolved, params.kind, params.body, { actor: 'analyst', surface: ctx.surface }, ctx.store, ctx.runtime?.notifyCard);
    if (!queued.ok) {
      const missingCards = queued.cardDeliveries.filter((delivery) => !delivery.result.ok && delivery.result.reason === 'missing_card').map((delivery) => delivery.cardId);
      return toolFailure(`Notification delivery failed for missing card(s): ${missingCards.join(', ')}.`, {
        reason: 'missing_card',
        recipient: params.recipient,
        cardIds: missingCards,
        notificationId: queued.notificationId,
        sessionDeliveries: queued.sessionDeliveries,
        deliveryFailures: queued.cardDeliveries
          .filter((delivery) => !delivery.result.ok)
          .map((delivery) => ({ cardId: delivery.cardId, reason: delivery.result.ok ? null : delivery.result.reason })),
      });
    }
    return { success: true, data: { queued: true, recipient: params.recipient } };
  } });
}

export async function show_config(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  try { const result = ctx.configAuthority.loadEffective(); return { success: true, data: { config: redactAnalystSecretValue(result.config) } }; }
  catch (err) { return toolFailureFromError(err); }
}

type ReconfigureParams = { action: 'set_role_routing' | 'set_failover_chain' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; name?: string; command?: string; args?: string[]; env?: Record<string, string>; key?: string; value?: unknown };

export async function reconfigure(ctx: ToolContext, params: ReconfigureParams): Promise<ToolResult> {
  if (params.action === 'mcp_add' || params.action === 'mcp_edit' || params.action === 'mcp_remove') {
    return toolFailure('MCP desired-config mutation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
  }
  const actionName = `reconfigure.${params.action.replace(/^set_/, 'set_')}`;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: 'config', getTargetId: () => params.name ?? params.role ?? params.key ?? params.action, lifecycle: 'intervention_ready', recheck: () => ({ allowed: true }), commit: () => {
    const invalid = (fieldPath: string, detail: string): ToolResult => toolFailure(detail, { reason: 'invalid_argument', fieldPath, detail });
    let mutation: ConfigMutation;
    switch (params.action) {
      case 'set_role_routing': mutation = { kind: 'set_role_routing', role: params.role!, modelCandidate: params.model_candidate! }; break;
      case 'set_failover_chain': mutation = { kind: 'set_failover_chain', forModel: params.for_model!, orderedFailoverModels: params.ordered_failover_models! }; break;
      case 'mcp_add': mutation = { kind: 'mcp_add', name: params.name!, command: params.command!, args: params.args, env: params.env }; break;
      case 'mcp_edit': mutation = { kind: 'mcp_edit', name: params.name!, patch: { command: params.command, args: params.args, env: params.env } }; break;
      case 'mcp_remove': mutation = { kind: 'mcp_remove', name: params.name! }; break;
      case 'set_runtime_setting': mutation = { kind: 'set_runtime_setting', key: params.key!, value: params.value }; break;
      case 'set_server_setting': mutation = { kind: 'set_server_setting', key: params.key!, value: params.value }; break;
      default: return invalid('action', 'Unknown reconfigure action.');
    }
    const result = ctx.configAuthority.applyChange(mutation);
    if (!result.success) {
      return invalid(result.fieldPath, result.message);
    }
    if (params.action === 'set_server_setting' && result.requires_restart) return { success: true, data: { applied: true, requires_restart: true, key: params.key } };
    return { success: true, data: { applied: true, action: params.action } };
  } });
}

export async function mcp_reconcile(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  return toolFailure('MCP reconciliation is unavailable until quiescent Pause is introduced.', { persisted: false, reconciled: false });
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try {
    const sessions = new AgentOperatorReadModelService(ctx.projectRoot).listSessions().sessions
      .filter((session) => session.role !== 'analyst' || session.id === GLOBAL_ANALYST_SESSION_ID);
    return { success: true, data: sessions };
  }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_agent_session(ctx: ToolContext, params: { sessionId: string; lastN?: number }): Promise<ToolResult> {
  try {
    if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) return toolFailure('sessionId is required.', { field: 'sessionId' });
    if (!isSafeAgentSessionId(params.sessionId)) return toolFailure('sessionId contains invalid characters.', { field: 'sessionId' });
    const limit = Math.min(Math.max(1, params.lastN ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX);
    const response = new AgentOperatorReadModelService(ctx.projectRoot).getConversation(params.sessionId);
    if (response.statusCode === 404) return toolFailure(`Agent session '${params.sessionId}' was not found.`, { sessionId: params.sessionId });
    if (response.statusCode) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId, statusCode: response.statusCode });
    if (!('entries' in response.body)) return toolFailure('Invalid agent session request.', { sessionId: params.sessionId });
    const entries = response.body.entries.slice(-limit);
    return { success: true, data: { session: response.body.session, total_messages: response.body.entries.length, returned: entries.length, parse_errors: 0, messages: entries } };
  }
  catch (err) { return toolFailureFromError(err); }
}

export const analystMiscTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'queue_notification', description: 'Queue a notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.', input: z.object({ recipient: describe(z.string(), 'A card id, an agent role, or an active session id.'), kind: describe(z.string(), 'A short categorical label for the notification.'), body: describe(z.string(), 'The notification text to inject.') }).strict(), roles: ['analyst', 'planner'], executor: queue_notification },
  { name: 'show_config', description: 'Show the current project configuration with secrets redacted.', input: emptyInput, roles: ['analyst'], executor: show_config },
  { name: 'reconfigure', description: 'Reconfigure role routing, failover, MCP servers, runtime, or server settings.', input: z.object({ action: z.enum(['set_role_routing', 'set_failover_chain', 'mcp_add', 'mcp_edit', 'mcp_remove', 'set_runtime_setting', 'set_server_setting']), role: z.string().optional(), model_candidate: z.string().optional(), for_model: z.string().optional(), ordered_failover_models: z.array(z.string()).optional(), name: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), key: z.string().optional(), value: z.unknown().optional() }).strict(), roles: ['analyst'], executor: reconfigure },
  { name: 'mcp_reconcile', description: 'Retry MCP runtime convergence from the already persisted configuration without writing configuration again.', input: emptyInput, roles: ['analyst'], executor: mcp_reconcile },
  { name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', input: emptyInput, roles: ['analyst'], executor: list_agent_sessions },
  { name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", input: z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_agent_session },
] as const;

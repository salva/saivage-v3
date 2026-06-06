import { z } from 'zod';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { queueNotification, resolveRecipient } from '../notifications/index.js';
import { assertAnalystInspectionTarget, redactAnalystSecretValue } from '../workspace/file-access-security.js';
import { getRedactedConfig, mcpAdd, mcpEdit, mcpRemove, setFailoverChain, setRoleRouting, setRuntimeSetting, setServerSetting } from '../agents/analyst-config-writer.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput, type UnifiedToolDefinition } from './tool-catalog.js';
import { readJsonlTail, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;
const GLOBAL_ANALYST_SESSION_ID = 'analyst';

export async function queue_notification(ctx: ToolContext, params: { recipient: string; kind: string; body: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, { recipient: params.recipient, kind: params.kind }, { action: 'notification.queue', safety_class: 'low', target_kind: 'session', getTargetId: () => params.recipient, run: async () => {
    const resolved = resolveRecipient(ctx.projectRoot, ctx.store, params.recipient);
    if (resolved === null) return { ...toolFailure('not_found', `Unknown notification recipient '${params.recipient}'.`, { reason: 'unknown_recipient', recipient: params.recipient }), data: { reason: 'unknown_recipient', recipient: params.recipient } };
    queueNotification(ctx.projectRoot, resolved, params.kind, params.body, { actor: 'analyst', surface: ctx.surface }, ctx.store);
    return { success: true, data: { queued: true, recipient: params.recipient } };
  } });
}

export async function show_config(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  try { const path = join(ctx.projectRoot, '.saivage', 'saivage.json'); assertAnalystInspectionTarget(path); const result = getRedactedConfig(ctx.projectRoot); if (!result.success) return { ...toolFailure('validation', result.message, { reason: 'invalid_argument', fieldPath: result.fieldPath, detail: result.message }), data: { reason: 'invalid_argument', fieldPath: result.fieldPath, detail: result.message } }; return { success: true, data: { config: redactAnalystSecretValue(result.config) } }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

type ReconfigureParams = { action: 'set_role_routing' | 'set_failover_chain' | 'mcp_add' | 'mcp_edit' | 'mcp_remove' | 'set_runtime_setting' | 'set_server_setting'; role?: string; model_candidate?: string; for_model?: string; ordered_failover_models?: string[]; name?: string; command?: string; args?: string[]; env?: Record<string, string>; key?: string; value?: unknown };

export async function reconfigure(ctx: ToolContext, params: ReconfigureParams): Promise<ToolResult> {
  const actionName = `reconfigure.${params.action.replace(/^set_/, 'set_')}`;
  return runAuditedAnalystTool(ctx, params as ReconfigureParams & Record<string, unknown>, { action: actionName, safety_class: 'low', target_kind: 'config', getTargetId: () => params.name ?? params.role ?? params.key ?? params.action, run: async () => {
    const invalid = (fieldPath: string, detail: string): ToolResult => ({ ...toolFailure('validation', detail, { reason: 'invalid_argument', fieldPath, detail }), data: { reason: 'invalid_argument', fieldPath, detail } });
    let result;
    switch (params.action) {
      case 'set_role_routing': result = setRoleRouting(ctx.projectRoot, params.role!, params.model_candidate!); break;
      case 'set_failover_chain': result = setFailoverChain(ctx.projectRoot, params.for_model!, params.ordered_failover_models!); break;
      case 'mcp_add': result = mcpAdd(ctx.projectRoot, params.name!, params.command!, params.args, params.env); if (result.success) { ctx.mcpManager?.reloadServersFromConfig(); await ctx.mcpManager?.startServer(params.name!); } break;
      case 'mcp_edit': result = mcpEdit(ctx.projectRoot, params.name!, { command: params.command, args: params.args, env: params.env }); if (result.success) { ctx.mcpManager?.reloadServersFromConfig(); await ctx.mcpManager?.restartServer(params.name!); } break;
      case 'mcp_remove': await ctx.mcpManager?.stopServer(params.name!); result = mcpRemove(ctx.projectRoot, params.name!); if (result.success) ctx.mcpManager?.reloadServersFromConfig(); break;
      case 'set_runtime_setting': result = setRuntimeSetting(ctx.projectRoot, params.key!, params.value); break;
      case 'set_server_setting': result = setServerSetting(ctx.projectRoot, params.key!, params.value); break;
      default: return invalid('action', 'Unknown reconfigure action.');
    }
    if (!result.success) return invalid(result.fieldPath, result.message);
    if (params.action === 'set_server_setting' && result.requires_restart) return { success: true, data: { applied: true, requires_restart: true, key: params.key } };
    return { success: true, data: { applied: true, action: params.action } };
  } });
}

export async function list_agent_sessions(ctx: ToolContext, _params: Record<string, never>): Promise<ToolResult> {
  try { const dir = join(ctx.projectRoot, '.saivage', 'agents', 'sessions'); if (!existsSync(dir)) return { success: true, data: [] }; const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); const sessions: Array<Record<string, unknown>> = files.flatMap((file): Array<Record<string, unknown>> => {
    try { const data = JSON.parse(readFileSync(join(dir, file), 'utf-8')) as Record<string, unknown>; const id = (data['id'] as string) ?? file.replace('.json', ''); if (data['role'] === 'analyst' && id !== GLOBAL_ANALYST_SESSION_ID) return []; return [{ id, role: data['role'] ?? null, status: data['status'] ?? null, started_at: data['started_at'] ?? null, card_id: data['card_id'] ?? null }]; }
    catch (err) { return [{ id: file.replace('.json', ''), error: err instanceof Error ? err.message : String(err) }]; }
  }); return { success: true, data: sessions }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function read_agent_session(ctx: ToolContext, params: { sessionId: string; lastN?: number }): Promise<ToolResult> {
  try { if (typeof params.sessionId !== 'string' || params.sessionId.length === 0) return toolFailure('validation', 'sessionId is required.', { field: 'sessionId' }); if (!/^[a-zA-Z0-9_-]+$/.test(params.sessionId)) return toolFailure('validation', 'sessionId contains invalid characters.', { field: 'sessionId' }); const sessionPath = join(ctx.projectRoot, '.saivage', 'agents', 'sessions', `${params.sessionId}.json`); const messagesPath = join(ctx.projectRoot, '.saivage', 'agents', 'messages', `${params.sessionId}.jsonl`); const session = existsSync(sessionPath) ? JSON.parse(readFileSync(sessionPath, 'utf-8')) : null; const limit = Math.min(Math.max(1, params.lastN ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const { entries, total, parseErrors } = readJsonlTail(messagesPath, limit); return { success: true, data: { session, total_messages: total, returned: entries.length, parse_errors: parseErrors, messages: entries } }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export const analystMiscTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'queue_notification', description: 'Queue a notification for delivery into the next agent session targeting a given card or role. The platform forgets the notification once it has been delivered; there is no list/get/acknowledge/delete.', input: z.object({ recipient: describe(z.string(), 'A card id, an agent role, or an active session id.'), kind: describe(z.string(), 'A short categorical label for the notification.'), body: describe(z.string(), 'The notification text to inject.') }).strict(), roles: ['analyst', 'planner'], executor: queue_notification, plannerControl: true },
  { name: 'show_config', description: 'Show the current project configuration with secrets redacted.', input: emptyInput, roles: ['analyst'], executor: show_config },
  { name: 'reconfigure', description: 'Reconfigure role routing, failover, MCP servers, runtime, or server settings.', input: z.object({ action: z.enum(['set_role_routing', 'set_failover_chain', 'mcp_add', 'mcp_edit', 'mcp_remove', 'set_runtime_setting', 'set_server_setting']), role: z.string().optional(), model_candidate: z.string().optional(), for_model: z.string().optional(), ordered_failover_models: z.array(z.string()).optional(), name: z.string().optional(), command: z.string().optional(), args: z.array(z.string()).optional(), env: z.record(z.string()).optional(), key: z.string().optional(), value: z.unknown().optional() }).strict(), roles: ['analyst'], executor: reconfigure },
  { name: 'list_agent_sessions', description: 'List all agent sessions in the project (analyst, planner, executor, etc.), not just the current analyst session.', input: emptyInput, roles: ['analyst'], executor: list_agent_sessions },
  { name: 'read_agent_session', description: "Read a specific agent session's metadata and most recent persisted messages. Useful for inspecting what other agents (planner, executor, etc.) have been doing.", input: z.object({ sessionId: z.string(), lastN: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_agent_session },
] as const;

import { z } from 'zod';
import { join } from 'node:path';

import { PROJECT_CARD_ID } from '../cards/store-api.js';
import { processApi } from '../runtime/process-api.js';
import { readRuntimeState } from '../runtime/state-api.js';
import { listControlActions } from '../persistence/index.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { describe, emptyInput, type UnifiedToolDefinition } from './tool-catalog.js';
import { readJsonlTail, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

export async function start_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.start_project', safety_class: 'low', target_kind: 'runtime', getTargetId: () => PROJECT_CARD_ID, run: async () => {
    if (!ctx.runtime) return toolFailure('conflict', 'Active runtime is not available.');
    const data = await ctx.runtime.startProject('analyst');
    return { success: data.success, ...(data.success ? { data } : { ...toolFailure('conflict', data.error.message), data }) };
  } });
}

export async function stop_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.stop_project', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => PROJECT_CARD_ID, run: async () => {
    if (!ctx.runtime) return toolFailure('conflict', 'Active runtime is not available.');
    const data = await ctx.runtime.stopProject('analyst'); return { success: true, data };
  } });
}

export async function terminate_process(ctx: ToolContext, params: { processId: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'process.terminate', safety_class: 'destructive', target_kind: 'process', getTargetId: (p) => p.processId, run: async () => {
    const proc = await processApi(ctx.projectRoot).terminate(params.processId); if (!proc) return toolFailure('not_found', `Process '${params.processId}' not found.`, { processId: params.processId }); return { success: true, data: proc };
  } });
}

export async function pause_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.pause', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => {
    if (!ctx.runtime) return toolFailure('conflict', 'Active runtime is not available.');
    ctx.runtime.pause();
    const state = readRuntimeState(ctx.projectRoot);
    return { success: true, data: { status: state?.status ?? 'unknown', paused: state?.paused ?? true } };
  } });
}

export async function resume_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.resume', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => {
    const state = readRuntimeState(ctx.projectRoot);
    if (state?.status === 'error') return toolFailure('conflict', 'Runtime is in error state. Inspect Debug errors/timeline and fix the underlying failure before attempting recovery.', { runtime_status: state.status });
    if (!ctx.runtime) return toolFailure('conflict', 'Active runtime is not available.');
    ctx.runtime.resume();
    const updated = readRuntimeState(ctx.projectRoot);
    return { success: true, data: { status: updated?.status ?? 'unknown', paused: updated?.paused ?? false } };
  } });
}

export async function restart_server(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.restart_server', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => 'server', run: async () => {
    if (!ctx.requestServerRestart) return toolFailure('conflict', 'Server restart primitive is not available.');
    await ctx.requestServerRestart(); return { success: true, data: { restart_requested: true } };
  } });
}

export async function read_runtime_events(ctx: ToolContext, params: { limit?: number; kind?: string }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const { entries, total, parseErrors } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'events.jsonl'), limit); const filtered = params.kind ? entries.filter((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)['kind'] === params.kind) : entries; return { success: true, data: { total_lines: total, returned: filtered.length, parse_errors: parseErrors, events: filtered } }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function read_runtime_errors(ctx: ToolContext, params: { limit?: number }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const { entries, total, parseErrors } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'errors.jsonl'), limit); return { success: true, data: { total_lines: total, returned: entries.length, parse_errors: parseErrors, errors: entries } }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function read_control_actions(ctx: ToolContext, params: { limit?: number; since?: string }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const all = listControlActions(ctx.projectRoot, params.since ? { since: params.since } : undefined); const tail = all.slice(-limit); return { success: true, data: { total_lines: all.length, returned: tail.length, actions: tail } }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export async function list_processes_tool(ctx: ToolContext, params: { status?: string; cardId?: string }): Promise<ToolResult> {
  try { const procs = processApi(ctx.projectRoot).listForAgent(params.cardId ? { cardId: params.cardId } : undefined); const filtered = params.status ? procs.filter((p) => p.status === params.status) : procs; return { success: true, data: filtered }; }
  catch (err) { return toolFailureFromError(err, 'io'); }
}

export const analystRuntimeTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'start_project', description: 'Start root project execution.', input: emptyInput, roles: ['analyst'], executor: start_project },
  { name: 'stop_project', description: 'Stop autonomous project execution.', input: emptyInput, roles: ['analyst'], executor: stop_project },
  { name: 'terminate_process', description: 'Terminate a live runtime process.', input: z.object({ processId: describe(z.string(), 'The process ID to terminate.') }).strict(), roles: ['analyst'], executor: terminate_process },
  { name: 'pause_runtime', description: 'Globally pause the runtime.', input: emptyInput, roles: ['analyst'], executor: pause_runtime },
  { name: 'resume_runtime', description: 'Resume the runtime after a pause.', input: emptyInput, roles: ['analyst'], executor: resume_runtime },
  { name: 'restart_server', description: 'Request a supervised server restart.', input: emptyInput, roles: ['analyst'], executor: restart_server },
  { name: 'read_runtime_events', description: 'Tail the project runtime events log (.saivage/runtime/events.jsonl). Optionally filter by event kind.', input: z.object({ limit: z.number().int().optional(), kind: z.string().optional() }).strict(), roles: ['analyst'], executor: read_runtime_events },
  { name: 'read_runtime_errors', description: 'Tail the project runtime errors log (.saivage/runtime/errors.jsonl).', input: z.object({ limit: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_runtime_errors },
  { name: 'read_control_actions', description: 'Tail the control-action audit log (.saivage/runtime/control-actions.jsonl). Shows mutating actions performed by analyst/planner/operator.', input: z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict(), roles: ['analyst'], executor: read_control_actions },
  { name: 'list_processes_tool', description: 'List all runtime processes (not card-scoped). Optionally filter by status (running, finished, failed, killed) or cardId.', input: z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict(), roles: ['analyst'], executor: list_processes_tool },
] as const;

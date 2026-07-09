import { z } from 'zod';
import { join } from 'node:path';

import { PROJECT_CARD_ID } from '../cards/store-api.js';
import { listControlActions } from '../persistence/index.js';
import type { ProcessRecord } from '../schemas/index.js';
import { redactCommandForOperator, toContainedRelativePath, workUrlFromAbsolutePath } from '../workspace/index.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { readJsonlTail, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';

const JSONL_TAIL_DEFAULT = 50;
const JSONL_TAIL_MAX = 1000;

function processView(projectRoot: string, record: ProcessRecord): Record<string, unknown> {
  const safePath = (path: string | null | undefined) => path ? toContainedRelativePath(projectRoot, path) : null;
  const logUrl = (path: string | null | undefined) => path ? workUrlFromAbsolutePath(projectRoot, path) : null;
  return {
    id: record.id,
    status: record.status,
    started_at: record.started_at,
    ended_at: record.completed_at ?? null,
    exit_code: record.exit_code ?? null,
    timed_out: record.exit_code === null && record.status === 'failed',
    owner_id: record.owner_id,
    owner_kind: record.owner_kind,
    session_id: record.agent_session_id ?? null,
    card_id: record.card_id,
    command: redactCommandForOperator(record.command),
    cwd: safePath(record.cwd),
    logs: { stdout: logUrl(record.stdout_path), stderr: logUrl(record.stderr_path) },
  };
}

export async function start_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.start_project', safety_class: 'low', target_kind: 'runtime', getTargetId: () => PROJECT_CARD_ID, run: async () => {
    if (!ctx.runtime) return toolFailure('Active runtime is not available.');
    const data = await ctx.runtime.startProject('analyst');
    if (!data.error) return { success: true, data };
    return toolFailure(data.error, { status: data.status, started: data.started, stopped: data.stopped });
  } });
}

export async function stop_project(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.stop_project', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => PROJECT_CARD_ID, run: async () => {
    if (!ctx.runtime) return toolFailure('Active runtime is not available.');
    const data = await ctx.runtime.stopProject('analyst'); return { success: true, data };
  } });
}

export async function pause_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.pause', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => {
    if (!ctx.runtime) return toolFailure('Active runtime is not available.');
    ctx.runtime.pause();
    const state = ctx.runtime.getStatus();
    return { success: true, data: { status: state.status } };
  } });
}

export async function resume_runtime(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.resume', safety_class: 'low', target_kind: 'runtime', getTargetId: () => 'project', run: async () => {
    if (!ctx.runtime) return toolFailure('Active runtime is not available.');
    const state = ctx.runtime.getStatus();
    if (state.status === 'error') return toolFailure('Runtime is in error state. Inspect Debug errors/timeline and fix the underlying failure before attempting recovery.', { runtime_status: state.status });
    ctx.runtime.resume();
    const updated = ctx.runtime.getStatus();
    return { success: true, data: { status: updated.status } };
  } });
}

export async function restart_server(ctx: ToolContext, params: Record<string, never> = {}): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'runtime.restart_server', safety_class: 'destructive', target_kind: 'runtime', getTargetId: () => 'server', run: async () => {
    if (!ctx.requestServerRestart) return toolFailure('Server restart primitive is not available.');
    await ctx.requestServerRestart(); return { success: true, data: { restart_requested: true } };
  } });
}

export async function read_runtime_events(ctx: ToolContext, params: { limit?: number; kind?: string }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const { entries, total, parseErrors } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'events.jsonl'), limit); const filtered = params.kind ? entries.filter((e) => typeof e === 'object' && e !== null && (e as Record<string, unknown>)['kind'] === params.kind) : entries; return { success: true, data: { total_lines: total, returned: filtered.length, parse_errors: parseErrors, events: filtered } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_runtime_errors(ctx: ToolContext, params: { limit?: number }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const { entries, total, parseErrors } = readJsonlTail(join(ctx.projectRoot, '.saivage', 'runtime', 'errors.jsonl'), limit); return { success: true, data: { total_lines: total, returned: entries.length, parse_errors: parseErrors, errors: entries } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_control_actions(ctx: ToolContext, params: { limit?: number; since?: string }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), JSONL_TAIL_MAX); const all = listControlActions(ctx.projectRoot, params.since ? { since: params.since } : undefined); const tail = all.slice(-limit); return { success: true, data: { total_lines: all.length, returned: tail.length, actions: tail } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function list_processes_tool(ctx: ToolContext, params: { status?: string; cardId?: string }): Promise<ToolResult> {
  try { const procs = ctx.processRunner.list(params.cardId ? { cardId: params.cardId } : undefined).map((record) => processView(ctx.projectRoot, record)); const filtered = params.status ? procs.filter((p) => p.status === params.status) : procs; return { success: true, data: filtered }; }
  catch (err) { return toolFailureFromError(err); }
}

export const analystRuntimeTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'start_project', description: 'Start root project execution.', input: emptyInput, roles: ['analyst'], executor: start_project },
  { name: 'stop_project', description: 'Stop autonomous project execution.', input: emptyInput, roles: ['analyst'], executor: stop_project },
  { name: 'pause_runtime', description: 'Globally pause the runtime.', input: emptyInput, roles: ['analyst'], executor: pause_runtime },
  { name: 'resume_runtime', description: 'Resume the runtime after a pause.', input: emptyInput, roles: ['analyst'], executor: resume_runtime },
  { name: 'restart_server', description: 'Request a supervised server restart.', input: emptyInput, roles: ['analyst'], executor: restart_server },
  { name: 'read_runtime_events', description: 'Tail the project runtime events log (.saivage/runtime/events.jsonl). Optionally filter by event kind.', input: z.object({ limit: z.number().int().optional(), kind: z.string().optional() }).strict(), roles: ['analyst'], executor: read_runtime_events },
  { name: 'read_runtime_errors', description: 'Tail the project runtime errors log (.saivage/runtime/errors.jsonl).', input: z.object({ limit: z.number().int().optional() }).strict(), roles: ['analyst'], executor: read_runtime_errors },
  { name: 'read_control_actions', description: 'Tail the control-action audit log (.saivage/runtime/control-actions.jsonl). Shows mutating actions performed by analyst/planner/operator.', input: z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict(), roles: ['analyst'], executor: read_control_actions },
  { name: 'list_processes_tool', description: 'List all runtime processes (not card-scoped). Optionally filter by status (running, finished, failed, killed) or cardId.', input: z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict(), roles: ['analyst'], executor: list_processes_tool },
] as const;

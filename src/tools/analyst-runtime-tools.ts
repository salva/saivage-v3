import { z } from 'zod';

import { listControlActions } from '../persistence/index.js';
import { eventKindValues } from '../schemas/index.js';
import type { ProcessRecord } from '../schemas/index.js';
import { redactCommandForOperator, toContainedRelativePath, workUrlFromAbsolutePath } from '../workspace/index.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineTool, type ToolDefinition } from './invocation.js';
import { EVENT_QUERY_MAX_LIMIT } from '../application/event-query-service.js';

const JSONL_TAIL_DEFAULT = 50;

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

export async function start_project(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  if (!ctx.runtimeControl) return toolFailure('Active runtime is not available.');
  const data = await ctx.runtimeControl.startProject();
  if (!data.error) return { success: true, data };
  return toolFailure(data.error, { status: data.status, started: data.started, stopped: data.stopped });
}

export async function pause_runtime(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  if (!ctx.runtimeControl) return toolFailure('Active runtime is not available.');
  ctx.runtimeControl.pause();
  const state = ctx.runtimeControl.getStatus();
  return { success: true, data: { status: state.status } };
}

export async function resume_runtime(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  if (!ctx.runtimeControl) return toolFailure('Active runtime is not available.');
  const state = ctx.runtimeControl.getStatus();
  if (state.status === 'error') return toolFailure('Runtime is in error state. Inspect Debug errors/timeline and fix the underlying failure before attempting recovery.', { runtime_status: state.status });
  ctx.runtimeControl.resume();
  const updated = ctx.runtimeControl.getStatus();
  return { success: true, data: { status: updated.status } };
}

export async function stop_project(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  if (!ctx.runtimeControl) return toolFailure('Active runtime is not available.');
  return { success: true, data: await ctx.runtimeControl.stopProject() };
}

export async function restart_server(ctx: ToolContext, _params: Record<string, never> = {}): Promise<ToolResult> {
  if (!ctx.restartServerAvailable) return toolFailure('restart unavailable: operator authentication disabled');
  return { success: true, data: { restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' } };
}

export async function read_runtime_events(ctx: ToolContext, params: { limit?: number; kind?: string }): Promise<ToolResult> {
  try { const limit = params.limit ?? JSONL_TAIL_DEFAULT; const result = ctx.eventQueries.queryEvents({ selection: 'newest_tail', limit, ...(params.kind ? { kind: params.kind as (typeof eventKindValues)[number] } : {}) }); const events = result.events; return { success: true, data: { total_lines: result.total, returned: events.length, parse_errors: 0, events } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_runtime_errors(ctx: ToolContext, params: { limit?: number }): Promise<ToolResult> {
  try { const result = ctx.eventQueries.queryErrors(params.limit ?? JSONL_TAIL_DEFAULT); const errors = result.errors; return { success: true, data: { total_lines: result.total, returned: errors.length, parse_errors: 0, errors } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function read_control_actions(ctx: ToolContext, params: { limit?: number; since?: string }): Promise<ToolResult> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), EVENT_QUERY_MAX_LIMIT); const all = listControlActions(ctx.projectRoot, params.since ? { since: params.since } : undefined); const tail = all.slice(-limit); return { success: true, data: { total_lines: all.length, returned: tail.length, actions: tail } }; }
  catch (err) { return toolFailureFromError(err); }
}

export async function list_processes_tool(ctx: ToolContext, params: { status?: string; cardId?: string }): Promise<ToolResult> {
  try { const procs = ctx.processRunner.list(params.cardId ? { cardId: params.cardId } : undefined).map((record) => processView(ctx.projectRoot, record)); const filtered = params.status ? procs.filter((p) => p.status === params.status) : procs; return { success: true, data: filtered }; }
  catch (err) { return toolFailureFromError(err); }
}

export function analystRuntimeTools(ctx: ToolContext): readonly ToolDefinition<any>[] { return [
  defineTool({ name: 'start_project', description: 'Start root project execution.', inputSchema: emptyInput, executor: (args) => start_project(ctx, args) }),
  defineTool({ name: 'pause_runtime', description: 'Globally pause the runtime.', inputSchema: emptyInput, executor: (args) => pause_runtime(ctx, args) }),
  defineTool({ name: 'resume_runtime', description: 'Resume the runtime after a pause.', inputSchema: emptyInput, executor: (args) => resume_runtime(ctx, args) }),
  defineTool({ name: 'stop_project', description: 'Stop project execution without disposing or restarting the server.', inputSchema: emptyInput, executor: (args) => stop_project(ctx, args) }),
  defineTool({ name: 'restart_server', description: 'Request confirmed supervised server shutdown.', inputSchema: emptyInput, executor: (args) => restart_server(ctx, args) }),
  defineTool({ name: 'read_runtime_events', description: 'Read the newest matching app-log-backed runtime events.', inputSchema: z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional(), kind: z.enum(eventKindValues).optional() }).strict(), executor: (args) => read_runtime_events(ctx, args) }),
  defineTool({ name: 'read_runtime_errors', description: 'Read the newest app-log-backed runtime error events.', inputSchema: z.object({ limit: z.number().int().positive().max(EVENT_QUERY_MAX_LIMIT).optional() }).strict(), executor: (args) => read_runtime_errors(ctx, args) }),
  defineTool({ name: 'read_control_actions', description: 'Tail app-log-backed control-action entries (.saivage/logs/app.jsonl, type=control_action). Shows mutating actions performed by analyst/planner/operator.', inputSchema: z.object({ limit: z.number().int().optional(), since: z.string().optional() }).strict(), executor: (args) => read_control_actions(ctx, args) }),
  defineTool({ name: 'list_processes_tool', description: 'List runtime processes. Processes may be card-owned or non-card; card_id is null for Analyst/operator/runtime processes, and owner_kind/owner_id identify the owner. Optionally filter by status (running, finished, failed, killed) or cardId.', inputSchema: z.object({ status: z.string().optional(), cardId: z.string().optional() }).strict(), executor: (args) => list_processes_tool(ctx, args) }),
]; }

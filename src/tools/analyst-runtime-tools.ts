import { listControlActions } from '../persistence/control-action-audit.js';
import type { AnalystToolOutcome, ToolContext } from './analyst-tool-types.js';
import { emptyInput } from './tool-definition.js';
import { toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, OPERATIONAL_RESULT_POLICY_TEMPLATE, type ToolBinder } from './invocation.js';
import { EVENT_QUERY_MAX_LIMIT } from '../application/event-query-service.js';
import { readControlActionsInputSchema } from '../contracts/builtin-tool-inputs.js';
import { toolSucceeded } from '../contracts/tool-result.js';

const JSONL_TAIL_DEFAULT = 50;

export async function start_project(ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  const data = await ctx.runtime.startProject();
  if (!data.error) return toolSucceeded(data);
  return toolFailure(data.error, { status: data.status, started: data.started, stopped: data.stopped });
}

export async function pause_runtime(ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  const state = ctx.runtime.getStatus();
  if (state.status !== 'running') return toolFailure(
    state.status === 'stopped'
      ? 'Runtime is stopped. Use start_project to start it; Pause is only available while the runtime is running.'
      : `Cannot pause runtime from '${state.status}'. Pause is only available while the runtime is running.`,
    { runtime_status: state.status },
  );
  ctx.runtime.pause();
  const updated = ctx.runtime.getStatus();
  return toolSucceeded({ status: updated.status });
}

export async function resume_runtime(ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  const state = ctx.runtime.getStatus();
  if (state.status === 'error') return toolFailure('Runtime is in error state. Inspect Debug Errors and fix the underlying failure before attempting recovery.', { runtime_status: state.status });
  if (state.status !== 'paused') return toolFailure(
    state.status === 'stopped'
      ? 'Runtime is stopped. Use start_project to start it; Resume is only available for paused execution.'
      : `Cannot resume runtime from '${state.status}'. Resume is only available for paused execution.`,
    { runtime_status: state.status },
  );
  ctx.runtime.resume();
  const updated = ctx.runtime.getStatus();
  return toolSucceeded({ status: updated.status });
}

export async function stop_project(ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  return toolSucceeded(await ctx.runtime.stopProject());
}

export async function restart_server(ctx: ToolContext, _params: Record<string, never> = {}): Promise<AnalystToolOutcome> {
  if (!ctx.restartCapability.available) return toolFailure('restart unavailable: operator authentication disabled');
  return toolSucceeded({ restart: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
}

async function read_control_actions(ctx: ToolContext, params: { limit?: number; since?: string }): Promise<AnalystToolOutcome> {
  try { const limit = Math.min(Math.max(1, params.limit ?? JSONL_TAIL_DEFAULT), EVENT_QUERY_MAX_LIMIT); const all = listControlActions(ctx.projectRoot, params.since ? { since: params.since } : undefined); const tail = all.slice(-limit); return toolSucceeded({ total_lines: all.length, returned: tail.length, actions: tail }); }
  catch (err) { return toolFailureFromError(err); }
}

export const analystRuntimeToolBinders: readonly ToolBinder<ToolContext, any>[] = Object.freeze([
  defineToolBinder({ name: 'start_project', description: 'Start root project execution.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => start_project(ctx, args)) }),
  defineToolBinder({ name: 'pause_runtime', description: 'Globally pause the runtime.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => pause_runtime(ctx, args)) }),
  defineToolBinder({ name: 'resume_runtime', description: 'Resume the runtime after a pause.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => resume_runtime(ctx, args)) }),
  defineToolBinder({ name: 'stop_project', description: 'Stop project execution without disposing or restarting the server.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => stop_project(ctx, args)) }),
  defineToolBinder({ name: 'restart_server', description: 'Request confirmed supervised server shutdown.', resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE, inputSchema: () => emptyInput, executor: (ctx, args) => executeToolAction('none', () => restart_server(ctx, args)) }),
  defineToolBinder({ name: 'read_control_actions', description: 'Tail app-log-backed control-action entries (.saivage/logs/app.jsonl, type=control_action). Shows mutating actions performed by analyst/planner/operator.', resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, inputSchema: () => readControlActionsInputSchema, executor: (ctx, args) => executeToolAction('observational_query', () => read_control_actions(ctx, args)) }),
]);

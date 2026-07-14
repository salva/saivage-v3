import { evaluateAuthz } from './authz.js';
import type { SafetyClass } from './authz.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import type { ToolContext, ToolResult } from '../tools/analyst-tool-types.js';
import { toolFailure } from '../tools/analyst-tool-helpers.js';

export type MutationAdmission = { allowed: true } | { allowed: false; reason: string };
export interface AnalystMutationReadContext {
  readonly projectRoot: string;
  readonly actor: ToolContext['actor'];
  readonly surface: ToolContext['surface'];
  readonly sessionId?: string;
  readonly services: NonNullable<ToolContext['analystPreparation']>;
}

export interface AnalystMutationContext {
  readonly actor: ToolContext['actor'];
  readonly surface: ToolContext['surface'];
  readonly services: NonNullable<ToolContext['analystMutations']>;
}

export interface MutatingSpec<P, Prepared = undefined> {
  readonly action: string;
  readonly safety_class: SafetyClass;
  readonly target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  readonly getTargetId: (params: P) => string | null;
  readonly lifecycle: 'intervention_ready';
  readonly prepare?: (params: P, ctx: AnalystMutationReadContext) => Promise<Prepared>;
  readonly recheck: (prepared: Prepared, params: P, ctx: AnalystMutationContext) => MutationAdmission;
  readonly commit: (prepared: Prepared, params: P, ctx: AnalystMutationContext) => ToolResult;
  readonly successSummary?: string;
}

function paramsSummary(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return stableStringify(params);
  const safe = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'body' && key !== 'content'));
  return stableStringify(safe);
}

export async function runAuditedAnalystTool<P extends object, Prepared = undefined>(ctx: ToolContext, params: P, spec: MutatingSpec<P, Prepared>): Promise<ToolResult> {
  const verdict = evaluateAuthz({ actor: ctx.actor, surface: ctx.surface, safety_class: spec.safety_class });
  const auditBase = { actor: ctx.actor, surface: ctx.surface, action: spec.action, target_kind: spec.target_kind, target_id: spec.getTargetId(params), params_summary: paramsSummary(params), safety_class: spec.safety_class };
  ctx.persistenceHealth.assertMutationHealthy();
  if (verdict === 'deny') {
    recordControlAction(ctx.appLogs, { ...auditBase, outcome: 'denied', outcome_summary: 'authz denied' }, ctx.eventBus);
    return toolFailure(`Denied by authorization policy for ${ctx.actor}/${ctx.surface}/${spec.safety_class}.`, { action: spec.action, safety_class: spec.safety_class });
  }
  const readServices = ctx.analystPreparation;
  if (spec.prepare && !readServices) throw new Error('Analyst preparation services are required for prepared mutations.');
  const readContext: AnalystMutationReadContext = { projectRoot: ctx.projectRoot, actor: ctx.actor, surface: ctx.surface, services: readServices!, ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }) };
  const prepared = spec.prepare ? await spec.prepare(params, readContext) : undefined as Prepared;
  ctx.persistenceHealth.assertMutationHealthy();
  ctx.interventionReadiness.assertInterventionReady();
  if (!ctx.analystMutations) throw new Error('Analyst mutation services are required for mutating tools.');
  const mutationContext: AnalystMutationContext = { actor: ctx.actor, surface: ctx.surface, services: ctx.analystMutations };
  const permission = spec.recheck(prepared, params, mutationContext);
  if (permission && !permission.allowed) {
    recordControlAction(ctx.appLogs, { ...auditBase, outcome: 'denied', outcome_summary: `permission denied: ${permission.reason}` }, ctx.eventBus);
    return toolFailure(`Denied by permission policy for ${spec.action}: ${permission.reason}.`, { action: spec.action, reason: permission.reason });
  }
  const result = spec.commit(prepared, params, mutationContext);
  recordControlAction(ctx.appLogs, {
    ...auditBase,
    outcome: result.success ? 'ok' : 'error',
    outcome_summary: result.success ? spec.successSummary ?? 'mutation applied' : result.error,
    ...(result.success ? {} : { error: result.error }),
  }, ctx.eventBus);
  return result;
}

export const ANALYST_CAPABILITY_CLASSES = ['Inspect', 'Navigate', 'Manage cards', 'Queue notifications', 'Control the runtime', 'Reconfigure', 'Investigate and repair'] as const;

export function ANALYST_UNSUPPORTED_ACTION_TEMPLATE(capabilityClass?: string, toolNames?: string[]): string {
  const suffix = capabilityClass && toolNames && toolNames.length > 0 ? ` Closest available capability: ${capabilityClass}. Available tools in that class: ${toolNames.join(', ')}.` : '';
  return `That action is not supported by the Analyst on this surface.${suffix}`;
}

export function ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(proposedToolName: string): string {
  return `The Analyst cannot perform ${proposedToolName}; it is not a registered capability. Available capability classes: ${ANALYST_CAPABILITY_CLASSES.join(', ')}.`;
}

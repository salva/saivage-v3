import { recordControlAction, stableStringify } from '../persistence/index.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import type { ToolContext, ToolResult } from '../tools/analyst-tool-types.js';
import { toolFailure } from '../tools/analyst-tool-helpers.js';
import type { AnalystMutationOutcome } from '../application/analyst-mutation-services.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';

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
  readonly safety_class: NonNullable<ControlActionAuditEntry['safety_class']>;
  readonly target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  readonly getTargetId: (params: P) => string | null;
  readonly lifecycle: 'intervention_ready' | 'runtime_cancellation';
  readonly prepare?: (params: P, ctx: AnalystMutationReadContext) => Promise<Prepared>;
  readonly mutate: (prepared: Prepared, params: P, ctx: AnalystMutationContext) => AnalystMutationOutcome | Promise<AnalystMutationOutcome>;
  readonly successSummary?: string;
}

function paramsSummary(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return stableStringify(params);
  const safe = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'body' && key !== 'content'));
  return stableStringify(safe);
}

export async function runAuditedAnalystTool<P extends object, Prepared = undefined>(ctx: ToolContext, params: P, spec: MutatingSpec<P, Prepared>, signal?: AbortSignal): Promise<ToolResult> {
  let settled = false;
  const settle = (entry: { outcome: 'denied' | 'error' | 'ok'; outcome_summary: string; error?: string }): void => {
    if (settled) throw new Error(`Analyst control action '${spec.action}' was settled more than once.`);
    settled = true;
    recordControlAction(ctx.projectRoot, () => ({
      actor: ctx.actor,
      surface: ctx.surface,
      action: spec.action,
      target_kind: spec.target_kind,
      target_id: spec.getTargetId(params),
      params_summary: paramsSummary(params),
      safety_class: spec.safety_class,
      ...entry,
    }));
  };
  let result: ToolResult;
  try {
    const readServices = ctx.analystPreparation;
    if (spec.prepare && !readServices) throw new Error('Analyst preparation services are required for prepared mutations.');
    const readContext: AnalystMutationReadContext = { projectRoot: ctx.projectRoot, actor: ctx.actor, surface: ctx.surface, services: readServices!, ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }) };
    const prepared = spec.prepare ? await spec.prepare(params, readContext) : undefined as Prepared;
    signal?.throwIfAborted();
    if (spec.lifecycle === 'intervention_ready') ctx.interventionReadiness.assertInterventionReady();
    if (!ctx.analystMutations) throw new Error('Analyst mutation services are required for mutating tools.');
    const mutationContext: AnalystMutationContext = { actor: ctx.actor, surface: ctx.surface, services: ctx.analystMutations };
    const outcome = await spec.mutate(prepared, params, mutationContext);
    if (outcome.kind === 'denied') {
      settle({ outcome: 'denied', outcome_summary: `application admission denied: ${outcome.reason}` });
      result = toolFailure(`Application denied ${spec.action}: ${outcome.reason}.`, { action: spec.action, reason: outcome.reason });
    } else {
      result = outcome.success
        ? { success: true, ...(outcome.data === undefined ? {} : { data: outcome.data }) }
        : { success: false, error: outcome.error, ...(outcome.data === undefined ? {} : { data: outcome.data }) };
      settle({
        outcome: result.success ? 'ok' : 'error',
        outcome_summary: result.success ? spec.successSummary ?? 'mutation applied' : result.error,
        ...(result.success ? {} : { error: result.error }),
      });
    }
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (settled) throw error;
    const summary = error instanceof Error ? error.message : String(error);
    settle({ outcome: 'error', outcome_summary: summary, error: summary });
    throw error;
  }
  signal?.throwIfAborted();
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

import { recordControlAction, stableStringify } from '../persistence/control-action-audit.js';
import type { ControlActionAuditEntry } from '../schemas/index.js';
import type { AnalystToolOutcome, ToolContext } from '../tools/analyst-tool-types.js';
import { executedToolOutcome, type ToolExecutionResult } from '../tools/invocation.js';
import { toolFailure } from '../tools/analyst-tool-helpers.js';
import type { AnalystMutationOutcome } from '../application/analyst-mutation-services.js';
import { throwIfPublicationOutcomeUnknown } from '../contracts/index.js';
import type { AnalystPreNetworkAdmission } from '../contracts/record-mutation.js';
import { toolFailed, toolSucceeded } from '../contracts/tool-result.js';

export interface AnalystMutationReadContext {
  readonly projectRoot: string;
  readonly actor: ToolContext['actor'];
  readonly surface: ToolContext['surface'];
  readonly sessionId?: string;
  readonly services: NonNullable<ToolContext['analystPreparation']>;
}

interface AnalystMutationContext {
  readonly actor: ToolContext['actor'];
  readonly surface: ToolContext['surface'];
  readonly services: NonNullable<ToolContext['analystMutations']>;
}

type AnalystLifecycleChecks = { kind: 'runtime_cancellation' } | { kind: 'intervention_ready'; timing: 'immediate_before_mutation' } | { kind: 'intervention_ready'; timing: 'before_pre_network_admission_and_immediate_before_mutation' };
interface MutatingSpecBase<P, Prepared> {
  readonly action: string;
  readonly safety_class: NonNullable<ControlActionAuditEntry['safety_class']>;
  readonly target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  readonly getTargetId: (params: P) => string | null;
  readonly lifecycle: AnalystLifecycleChecks;
  readonly mutate: (prepared: Prepared, params: P, ctx: AnalystMutationContext) => AnalystMutationOutcome | Promise<AnalystMutationOutcome>;
  readonly successSummary?: string;
}
type MutatingSpec<P, Prepared = undefined> =
  | (MutatingSpecBase<P, Prepared> & { lifecycle: { kind: 'intervention_ready'; timing: 'before_pre_network_admission_and_immediate_before_mutation' }; prepare: (params: P, ctx: AnalystMutationReadContext) => Promise<Prepared>; admitBeforePrepare: (params: P, ctx: AnalystMutationReadContext) => AnalystPreNetworkAdmission })
  | (MutatingSpecBase<P, Prepared> & { lifecycle: { kind: 'intervention_ready'; timing: 'immediate_before_mutation' } | { kind: 'runtime_cancellation' }; prepare?: (params: P, ctx: AnalystMutationReadContext) => Promise<Prepared>; admitBeforePrepare?: never });

function paramsSummary(params: unknown): string {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return stableStringify(params);
  const safe = Object.fromEntries(Object.entries(params).filter(([key]) => key !== 'body' && key !== 'content'));
  return stableStringify(safe);
}

export async function runAuditedAnalystTool<P extends object, Prepared = undefined>(ctx: ToolContext, params: P, spec: MutatingSpec<P, Prepared>, signal?: AbortSignal): Promise<ToolExecutionResult<'none'>> {
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
  let result: AnalystToolOutcome;
  try {
    const readServices = ctx.analystPreparation;
    if (spec.prepare && !readServices) throw new Error('Analyst preparation services are required for prepared mutations.');
    const readContext: AnalystMutationReadContext = { projectRoot: ctx.projectRoot, actor: ctx.actor, surface: ctx.surface, services: readServices!, ...(ctx.sessionId === undefined ? {} : { sessionId: ctx.sessionId }) };
    let prepared: Prepared;
    if ('admitBeforePrepare' in spec && spec.admitBeforePrepare) {
      signal?.throwIfAborted(); ctx.interventionReadiness.assertInterventionReady();
      const admission = spec.admitBeforePrepare(params, readContext);
      if (!admission.ok) {
        settle({ outcome: admission.audit_outcome, outcome_summary: admission.result.error, ...(admission.audit_outcome === 'error' ? { error: admission.result.error } : {}) });
        return executedToolOutcome('none', toolFailed(admission.result.error, admission.result.data));
      }
      prepared = await spec.prepare!(params, readContext);
      signal?.throwIfAborted(); ctx.interventionReadiness.assertInterventionReady();
    } else {
      prepared = spec.prepare ? await spec.prepare(params, readContext) : undefined as Prepared;
      signal?.throwIfAborted();
      if (spec.lifecycle.kind === 'intervention_ready') ctx.interventionReadiness.assertInterventionReady();
    }
    if (!ctx.analystMutations) throw new Error('Analyst mutation services are required for mutating tools.');
    const mutationContext: AnalystMutationContext = { actor: ctx.actor, surface: ctx.surface, services: ctx.analystMutations };
    const outcome = await spec.mutate(prepared, params, mutationContext);
    if (outcome.kind === 'denied') {
      settle({ outcome: 'denied', outcome_summary: `application admission denied: ${outcome.reason}` });
      result = toolFailure(`Application denied ${spec.action}: ${outcome.reason}.`, { action: spec.action, reason: outcome.reason });
    } else {
      result = outcome.success ? toolSucceeded(outcome.data) : toolFailed(outcome.error, outcome.data);
      const classifiedDenied = outcome.success === false && typeof outcome.data === 'object' && outcome.data !== null && (outcome.data as { code?: string }).code === 'record_mutation_denied';
      settle({
        outcome: outcome.success ? 'ok' : classifiedDenied ? 'denied' : 'error',
        outcome_summary: outcome.success ? spec.successSummary ?? 'mutation applied' : outcome.error,
        ...(outcome.success ? {} : { error: outcome.error }),
      });
    }
  } catch (error) {
    throwIfPublicationOutcomeUnknown(error);
    if (settled) throw error;
    const summary = error instanceof Error ? error.message : String(error);
    settle({ outcome: 'error', outcome_summary: summary, error: summary });
    throw error;
  }
  return executedToolOutcome('none', result);
}

export function ANALYST_UNSUPPORTED_ACTION_TEMPLATE(capabilityClass?: string, toolNames?: string[]): string {
  const suffix = capabilityClass && toolNames && toolNames.length > 0 ? ` Closest available capability: ${capabilityClass}. Available tools in that class: ${toolNames.join(', ')}.` : '';
  return `That action is not supported by the Analyst on this surface.${suffix}`;
}

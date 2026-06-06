import { evaluateAuthz } from './authz.js';
import type { SafetyClass } from './authz.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import type { ToolContext, ToolResult, ActionPreview } from '../tools/analyst-tool-types.js';
import { toolFailure } from '../tools/analyst-tool-helpers.js';

export interface MutatingSpec<P> {
  action: string;
  safety_class: SafetyClass;
  target_kind: 'card' | 'note' | 'process' | 'runtime' | 'config' | 'session' | null;
  getTargetId: (params: P) => string | null;
  preview?: (ctx: ToolContext, params: P) => ActionPreview | null;
  run: (ctx: ToolContext, params: P) => Promise<ToolResult>;
}

function paramsSummary(params: unknown): string { return stableStringify(params); }

export async function runAuditedAnalystTool<P extends Record<string, unknown>>(ctx: ToolContext, params: P, spec: MutatingSpec<P>): Promise<ToolResult> {
  const verdict = evaluateAuthz({ actor: ctx.actor, surface: ctx.surface, safety_class: spec.safety_class });
  const auditBase = { actor: ctx.actor, surface: ctx.surface, action: spec.action, target_kind: spec.target_kind, target_id: spec.getTargetId(params), params_summary: paramsSummary(params), safety_class: spec.safety_class };
  if (verdict === 'deny') {
    recordControlAction(ctx.projectRoot, { ...auditBase, outcome: 'denied', outcome_summary: 'authz denied' }, ctx.eventBus);
    return toolFailure('permission', `Denied by authorization policy for ${ctx.actor}/${ctx.surface}/${spec.safety_class}.`, { action: spec.action, safety_class: spec.safety_class });
  }
  const result = await spec.run(ctx, params);
  recordControlAction(ctx.projectRoot, {
    ...auditBase,
    outcome: result.success ? 'ok' : 'error',
    outcome_summary: result.success ? 'mutation applied' : (result.error ?? 'mutation failed'),
    ...(result.success ? {} : { error: result.error ?? 'mutation failed' }),
  }, ctx.eventBus);
  return result;
}

export const ANALYST_CAPABILITY_CLASSES = ['Inspect', 'Navigate', 'Mutate cards', 'Queue notifications', 'Control the runtime', 'Reconfigure', 'Investigate and repair'] as const;

export function ANALYST_UNSUPPORTED_ACTION_TEMPLATE(capabilityClass?: string, toolNames?: string[]): string {
  const suffix = capabilityClass && toolNames && toolNames.length > 0 ? ` Closest available capability: ${capabilityClass}. Available tools in that class: ${toolNames.join(', ')}.` : '';
  return `That action is not supported by the Analyst on this surface.${suffix}`;
}

export function ANALYST_PARTIAL_SUCCESS_TEMPLATE(succeeded: number, total: number, failedIds: string[], reasons: string[]): string {
  return `Partial success: ${succeeded} of ${total} succeeded. Failed: ${failedIds.join(', ')}. Reasons: ${reasons.join('; ')}.`;
}

export function ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(proposedToolName: string): string {
  return `The Analyst cannot perform ${proposedToolName}; it is not a registered capability. Available capability classes: ${ANALYST_CAPABILITY_CLASSES.join(', ')}.`;
}

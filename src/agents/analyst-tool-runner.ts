import { evaluateAuthz } from './authz.js';
import type { SafetyClass } from './authz.js';
import { recordControlAction, stableStringify } from '../persistence/index.js';
import type { ToolContext, ToolResult, ActionPreview } from './analyst-tools.js';

export const CONFIRMATION_TTL_MS = 300_000;

export interface PendingDestructiveInvocation {
  sessionId: string;
  tool: string;
  params: Record<string, unknown>;
  createdAt: number;
  actionVerb?: string;
  targetDescription?: string;
  ids?: string[];
}

export class PendingDestructiveStore {
  private readonly pending = new Map<string, PendingDestructiveInvocation>();

  set(sessionId: string, invocation: PendingDestructiveInvocation): void { this.pending.set(sessionId, invocation); }
  get(sessionId: string): PendingDestructiveInvocation | undefined { return this.pending.get(sessionId); }
  delete(sessionId: string): boolean { return this.pending.delete(sessionId); }
  prune(now: number = Date.now()): PendingDestructiveInvocation[] {
    const expired: PendingDestructiveInvocation[] = [];
    for (const [sessionId, invocation] of this.pending.entries()) {
      if (now - invocation.createdAt > CONFIRMATION_TTL_MS) {
        expired.push(invocation);
        this.pending.delete(sessionId);
      }
    }
    return expired;
  }
}

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
  const auditBase = { actor: ctx.actor, surface: ctx.surface, action: spec.action, target_kind: spec.target_kind, target_id: spec.getTargetId(params), confirmed: true, params_summary: paramsSummary(params), safety_class: spec.safety_class };
  if (verdict === 'deny' || (verdict === 'preview_only' && !(spec.safety_class === 'destructive' && ctx.confirmedDestructive === true))) {
    recordControlAction(ctx.projectRoot, { ...auditBase, outcome: verdict === 'deny' ? 'denied' : 'rejected', outcome_summary: verdict === 'deny' ? 'authz denied' : 'interactive confirmation gate removed; use an authorized runtime/tool surface' });
    return { success: false, error: verdict === 'deny' ? `Denied by authorization policy for ${ctx.actor}/${ctx.surface}/${spec.safety_class}.` : `Action '${spec.action}' requires an authorized surface. confirmed/preview_hash confirmation is no longer accepted by mutation contracts.` };
  }
  const result = await spec.run(ctx, params);
  recordControlAction(ctx.projectRoot, {
    ...auditBase,
    outcome: result.success ? 'ok' : 'error',
    outcome_summary: result.success ? 'mutation applied' : (result.error ?? 'mutation failed'),
    ...(result.success ? {} : { error: result.error ?? 'mutation failed' }),
  });
  return result;
}

export const ANALYST_CAPABILITY_CLASSES = ['Inspect', 'Navigate', 'Mutate cards', 'Queue notifications', 'Control the runtime', 'Reconfigure', 'Investigate and repair'] as const;

export const ANALYST_TOOL_SAFETY_CLASS: Record<string, SafetyClass> = {
  delete_card: 'destructive',
  stop_project: 'destructive',
  terminate_process: 'destructive',
  abort_goal_subtree: 'destructive',
  restart_card_or_subtree: 'destructive',
  restart_goal: 'destructive',
  mark_goal_needs_corrections: 'destructive',
  restart_server: 'destructive',
};

export function isDestructiveAnalystTool(toolName: string): boolean {
  return ANALYST_TOOL_SAFETY_CLASS[toolName] === 'destructive';
}

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

export function ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE(actionVerb: string, targetDescription: string, n: number, ids: string[]): string {
  return `About to ${actionVerb} ${targetDescription}. This will affect ${n} item(s): ${ids.join(', ')}. Reply 'yes' to proceed, 'no' to cancel, or describe an amendment.`;
}

export function ANALYST_DESTRUCTIVE_AMENDMENT_TEMPLATE(actionVerb: string, targetDescription: string): string {
  return `Amended. New proposal: ${actionVerb} ${targetDescription}. Reply 'yes' to proceed, 'no' to cancel, or describe a further amendment.`;
}

export function ANALYST_DESTRUCTIVE_STALE_AFFIRMATION_TEMPLATE(): string {
  return 'The previous confirmation expired. Restate the request if you still want it.';
}

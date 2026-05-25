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
  const auditBase = { actor: ctx.actor, surface: ctx.surface, action: spec.action, target_kind: spec.target_kind, target_id: spec.getTargetId(params), confirmed: true, params_summary: paramsSummary(params) };
  if (verdict === 'deny' || verdict === 'preview_only') {
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

export function ANALYST_UNSUPPORTED_ACTION_TEMPLATE(capabilityClass?: string, toolNames?: string[]): string {
  const suffix = toolNames && toolNames.length > 0 ? ` Available ${capabilityClass ?? 'capability'} tools: ${toolNames.join(', ')}.` : '';
  return `Unsupported action: the Analyst cannot perform that request with the registered ${capabilityClass ?? 'capability'} surface.${suffix}`;
}

export function ANALYST_PARTIAL_SUCCESS_TEMPLATE(succeeded: number, total: number, failedIds: string[], reasons: string[]): string {
  const failures = failedIds.map((id, i) => `${id}: ${reasons[i] ?? 'unknown reason'}`).join('; ');
  return `Partial success: ${succeeded}/${total} item(s) succeeded. Failed item(s): ${failures}.`;
}

export function ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(proposedToolName: string): string {
  return `Unknown capability: '${proposedToolName}' is not a registered Analyst tool. No action was performed.`;
}

export function ANALYST_DESTRUCTIVE_PREVIEW_TEMPLATE(actionVerb: string, targetDescription: string, n: number, ids: string[]): string {
  return `Please confirm: ${actionVerb} ${targetDescription} affecting ${n} item(s): ${ids.join(', ')}. Reply yes to proceed or no to cancel.`;
}

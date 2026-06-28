import { z } from 'zod';

import { deleteDiary } from '../cards/diary.js';
import { decide } from '../permissions/index.js';
import { runAuditedAnalystTool } from '../agents/analyst-tool-runner.js';
import type { ToolContext, ToolResult } from './analyst-tool-types.js';
import { buildAbortPreview, buildRestartGoalPreview, cardSummary, getStore, saivageDir, toolFailure, toolFailureFromError } from './analyst-tool-helpers.js';
import { describe, type UnifiedToolDefinition } from './tool-catalog.js';

export async function abort_goal_subtree(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'goal.abort', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.goalId, preview: () => buildAbortPreview(ctx.projectRoot, getStore(ctx), params.goalId), run: async () => {
    const store = getStore(ctx);
    try {
      const goal = store.read(params.goalId); if (!goal) return toolFailure('not_found', `Goal '${params.goalId}' not found.`, { goalId: params.goalId });
      const cancelled: string[] = [];
      for (const id of [params.goalId, ...store.getDescendantIds(params.goalId)]) {
        const card = store.read(id); if (!card) continue;
        const decision = decide({ role: 'analyst', action: 'card.cancel', targetState: card.status });
        if (!decision.allowed) return toolFailure('permission', `Card '${id}' in status '${card.status}' cannot be cancelled by analyst (${decision.reason}).`, { id, status: card.status });
        store.setStatus(id, 'cancelled'); cancelled.push(id);
      }
      return { success: true, data: { cancelled } };
    } catch (err) { return toolFailureFromError(err); }
  } });
}

export async function restart_card_or_subtree(ctx: ToolContext, params: { id: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'card.restart', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.id, preview: () => {
    const store = getStore(ctx); const card = store.read(params.id);
    return card ? { type: 'restart_card', summary: `Restart card '${card.title}' (${card.id}) - will be moved to backlog.`, affectedCards: [cardSummary(card)], affectedProcesses: [], warnings: ['Card result and error will be cleared.'] } : { type: 'restart_card', summary: `Restart card '${params.id}'.`, affectedCards: [], affectedProcesses: [], warnings: [] };
  }, run: async () => {
    const store = getStore(ctx);
    try {
      const card = store.read(params.id); if (!card) return toolFailure('not_found', `Card '${params.id}' not found.`, { id: params.id });
      if (card.type === 'goal' || card.type === 'project') return restart_goal(ctx, { goalId: params.id });
      if (!decide({ role: 'analyst', action: 'card.restart', targetState: card.status }).allowed) return toolFailure('permission', `Card '${params.id}' has status '${card.status}'. Only matrix-allowed states can be restarted by analyst.`, { id: params.id, status: card.status });
      return { success: true, data: store.repairTerminalLifecycle(params.id, { status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } }) };
    } catch (err) { return toolFailureFromError(err); }
  } });
}

export async function restart_goal(ctx: ToolContext, params: { goalId: string }): Promise<ToolResult> {
  return runAuditedAnalystTool(ctx, params, { action: 'goal.restart', safety_class: 'destructive', target_kind: 'card', getTargetId: (p) => p.goalId, preview: () => buildRestartGoalPreview(ctx.projectRoot, getStore(ctx), params.goalId), run: async () => {
    const store = getStore(ctx);
    try {
      const goal = store.read(params.goalId); if (!goal) return toolFailure('not_found', `Goal '${params.goalId}' not found.`, { goalId: params.goalId });
      const restartDecision = decide({ role: 'analyst', action: 'card.restart', targetState: goal.status });
      if (!restartDecision.allowed) return toolFailure('permission', `Goal '${params.goalId}' has status '${goal.status}' and cannot be restarted by analyst (${restartDecision.reason}).`, { goalId: params.goalId, status: goal.status });
      for (const id of store.getDescendantIds(params.goalId)) {
        const child = store.read(id); if (!child || child.status !== 'running') continue;
        const cancelDecision = decide({ role: 'analyst', action: 'card.cancel', targetState: child.status });
        if (!cancelDecision.allowed) return toolFailure('permission', `Descendant card '${id}' in status '${child.status}' cannot be cancelled by analyst (${cancelDecision.reason}).`, { id, status: child.status });
        store.setStatus(id, 'cancelled');
      }
      try { deleteDiary(saivageDir(ctx.projectRoot), params.goalId); } catch { /* best-effort cleanup; restart repair below is authoritative */ }
      store.repairTerminalLifecycle(params.goalId, { status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null } });
      return { success: true, data: { goalId: params.goalId, status: 'backlog', descendantIds: store.getDescendantIds(params.goalId) } };
    } catch (err) { return toolFailureFromError(err); }
  } });
}

export const analystSubtreeTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'abort_goal_subtree', description: 'Abort a goal and all descendants.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card to abort.') }).strict(), roles: [], executor: abort_goal_subtree },
  { name: 'restart_card_or_subtree', description: 'Restart a completed, failed, or cancelled card or goal subtree.', input: z.object({ id: describe(z.string(), 'The ID of the card/goal to restart.') }).strict(), roles: [], executor: restart_card_or_subtree },
  { name: 'restart_goal', description: 'Restart a goal.', input: z.object({ goalId: describe(z.string(), 'The ID of the goal card to restart.') }).strict(), roles: [], executor: restart_goal },
] as const;

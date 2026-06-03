import type { CardRecord } from '../../schemas/index.js';
import type { PlannerPostDispatchDecision } from './planner-phase.js';

export interface PlannerPostDispatchEffects {
  blockGoalWithPlanning(input: {
    goalId: string;
    blockedReason: string;
    planning: Record<string, unknown>;
    terminalReason: string;
  }): Promise<void>;
  updateGoalCard(goalId: string, patch: Partial<CardRecord>): Promise<unknown> | unknown;
  transitionGoalExit(goalId: string, reason: string): Promise<unknown>;
}

export async function handlePlannerPostDispatchDecision(input: {
  goalId: string;
  decision: PlannerPostDispatchDecision;
  effects: PlannerPostDispatchEffects;
}): Promise<{ plannerDone: boolean; shouldReturn: boolean }> {
  switch (input.decision.kind) {
    case 'block':
      await input.effects.blockGoalWithPlanning({
        goalId: input.goalId,
        blockedReason: input.decision.blockedReason,
        planning: input.decision.planning,
        terminalReason: input.decision.terminalReason,
      });
      return { plannerDone: false, shouldReturn: true };
    case 'continue':
      await input.effects.updateGoalCard(input.goalId, input.decision.patch);
      return { plannerDone: false, shouldReturn: false };
    case 'exit_with_unfinished_child_work':
      await input.effects.updateGoalCard(input.goalId, input.decision.patch);
      await input.effects.transitionGoalExit(input.goalId, input.decision.terminalReason);
      return { plannerDone: false, shouldReturn: true };
    case 'ready_for_review':
      return { plannerDone: true, shouldReturn: false };
  }
}

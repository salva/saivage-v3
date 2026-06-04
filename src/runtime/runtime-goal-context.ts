import { join } from 'node:path';
import type { RuntimeContextCardReader } from './context-builder.js';
import {
  buildGoalContextBlock as renderGoalContextBlock,
  buildGoalContextPayload,
} from './context-builder.js';
import { inferGoalResumeReason, type GoalResumeReason } from './goal-context.js';
import {
  drainSyntheticPlannerNotes,
  injectQueuedSyntheticPlannerNotes,
} from './synthetic-planner-notes.js';
import { appendMessage } from './session-persistence.js';
import { readRuntimeState } from './state.js';
import type { SessionStamper } from '../contracts/session-stamper.js';

export interface RuntimeGoalContextCoordinator {
  inferResumeReason(goalId: string, fallback?: GoalResumeReason): GoalResumeReason;
  buildGoalContextBlock(goalId: string, resumeReason?: GoalResumeReason): string;
  appendPlannerResumeContext(goalId: string, plannerSessionId: string, resumeReason: GoalResumeReason): void;
  injectQueuedPlannerNotes(plannerSessionId: string): void;
}

export function createRuntimeGoalContextCoordinator(deps: {
  projectRoot: string;
  cards: RuntimeContextCardReader;
  sessionStamper: SessionStamper;
}): RuntimeGoalContextCoordinator {
  const buildGoalContextNotes = (goalId: string): Array<Record<string, unknown>> =>
    drainSyntheticPlannerNotes(deps.projectRoot, `planner:${goalId}`).map((note) => ({
      kind: note.kind,
      origin_card_id: note.affected_card_id,
      descendant_card_ids: note.descendant_card_ids,
      body: note.summary,
      at: note.created_at,
    }));

  const coordinator: RuntimeGoalContextCoordinator = {
    inferResumeReason(goalId: string, fallback: GoalResumeReason = 'initial'): GoalResumeReason {
    const state = readRuntimeState(deps.projectRoot);
    const notes = buildGoalContextNotes(goalId);
    return inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes });
    },

    buildGoalContextBlock(goalId: string, resumeReason: GoalResumeReason = 'initial'): string {
    const state = readRuntimeState(deps.projectRoot);
    const payload = buildGoalContextPayload({
      goalId,
      resumeReason,
      cards: deps.cards,
      notes: buildGoalContextNotes(goalId),
      activeRun: state?.active_card_run?.card_id === goalId ? state.active_card_run : null,
    });
    return renderGoalContextBlock({ goalId, resumeReason, payload });
    },

    appendPlannerResumeContext(
    goalId: string,
    plannerSessionId: string,
    resumeReason: GoalResumeReason,
  ): void {
    appendMessage(
      join(deps.projectRoot, '.saivage'),
      plannerSessionId,
      { role: 'user', kind: 'text', content: coordinator.buildGoalContextBlock(goalId, resumeReason) },
      deps.sessionStamper.stampUserMessage(plannerSessionId),
      deps.sessionStamper,
    );
    },

    injectQueuedPlannerNotes(plannerSessionId: string): void {
    injectQueuedSyntheticPlannerNotes(deps.projectRoot, plannerSessionId, {
      stampUserMessage: (sessionId) => deps.sessionStamper.stampUserMessage(sessionId),
    });
    },
  };
  return coordinator;
}

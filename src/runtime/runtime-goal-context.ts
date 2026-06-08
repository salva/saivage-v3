import { join } from 'node:path';
import type { RuntimeContextCardReader } from './context-builder.js';
import {
  buildGoalContextBlock as renderGoalContextBlock,
  buildGoalContextPayload,
} from './context-builder.js';
import { inferGoalResumeReason, type GoalResumeReason } from './goal-context.js';
import {
  drainSyntheticPlannerNotes,
  type SyntheticPlannerNote,
} from './synthetic-planner-notes.js';
import { appendMessage } from './session-persistence.js';
import { readRuntimeState } from './state.js';
import type { SessionStamper } from './session-stamper.js';

export interface RuntimeGoalContextCoordinator {
  inferResumeReason(goalId: string, fallback?: GoalResumeReason): GoalResumeReason;
  buildGoalContextBlock(goalId: string, resumeReason?: GoalResumeReason): string;
  buildPlannerGoalContext(goalId: string, fallback?: GoalResumeReason): { resumeReason: GoalResumeReason; goalContext: string };
  appendPlannerResumeContext(goalId: string, plannerSessionId: string, resumeReason: GoalResumeReason): void;
  injectQueuedPlannerNotes(plannerSessionId: string): void;
}

export function createRuntimeGoalContextCoordinator(deps: {
  projectRoot: string;
  cards: RuntimeContextCardReader;
  sessionStamper: SessionStamper;
}): RuntimeGoalContextCoordinator {
  const projectNote = (note: SyntheticPlannerNote): Record<string, unknown> => ({
      kind: note.kind,
      origin_card_id: note.affected_card_id,
      descendant_card_ids: note.descendant_card_ids,
      body: note.summary,
      at: note.created_at,
      ...(note.previous_status ? { previous_status: note.previous_status } : {}),
    });

  const renderContext = (goalId: string, resumeReason: GoalResumeReason, notes: Array<Record<string, unknown>>): string => {
    const state = readRuntimeState(deps.projectRoot);
    const payload = buildGoalContextPayload({
      goalId,
      resumeReason,
      cards: deps.cards,
      notes,
      activeRun: state?.active_card_run?.card_id === goalId ? state.active_card_run : null,
    });
    return renderGoalContextBlock({ goalId, resumeReason, payload });
  };

  const coordinator: RuntimeGoalContextCoordinator = {
    inferResumeReason(goalId: string, fallback: GoalResumeReason = 'initial'): GoalResumeReason {
    const state = readRuntimeState(deps.projectRoot);
    return inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes: [] });
    },

    buildGoalContextBlock(goalId: string, resumeReason: GoalResumeReason = 'initial'): string {
    return renderContext(goalId, resumeReason, []);
    },

    buildPlannerGoalContext(goalId: string, fallback: GoalResumeReason = 'initial'): { resumeReason: GoalResumeReason; goalContext: string } {
    const state = readRuntimeState(deps.projectRoot);
    const notes = drainSyntheticPlannerNotes(deps.projectRoot, `planner:${goalId}`).map(projectNote);
    const resumeReason = inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes });
    return { resumeReason, goalContext: renderContext(goalId, resumeReason, notes) };
    },

    appendPlannerResumeContext(
    goalId: string,
    plannerSessionId: string,
    resumeReason: GoalResumeReason,
  ): void {
    appendMessage(
      join(deps.projectRoot, '.saivage'),
      plannerSessionId,
      { role: 'user', kind: 'text', content: coordinator.buildPlannerGoalContext(goalId, resumeReason).goalContext },
      deps.sessionStamper.stampUserMessage(plannerSessionId),
      deps.sessionStamper,
    );
    },

    injectQueuedPlannerNotes(plannerSessionId: string): void {
    void plannerSessionId;
    },
  };
  return coordinator;
}

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
import { readRuntimeState } from './state.js';

export interface RuntimeGoalContextCoordinator {
  buildGoalContextBlock(goalId: string, resumeReason?: GoalResumeReason): string;
  buildPlannerGoalContext(goalId: string, fallback?: GoalResumeReason): { resumeReason: GoalResumeReason; goalContext: string };
}

export function createRuntimeGoalContextCoordinator(deps: {
  projectRoot: string;
  cards: RuntimeContextCardReader;
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
      projectRoot: deps.projectRoot,
      goalId,
      resumeReason,
      cards: deps.cards,
      notes,
      activeRun: state?.active_card_run?.card_id === goalId ? state.active_card_run : null,
    });
    return renderGoalContextBlock({ goalId, resumeReason, payload });
  };

  const coordinator: RuntimeGoalContextCoordinator = {
    buildGoalContextBlock(goalId: string, resumeReason: GoalResumeReason = 'initial'): string {
    return renderContext(goalId, resumeReason, []);
    },

    buildPlannerGoalContext(goalId: string, fallback: GoalResumeReason = 'initial'): { resumeReason: GoalResumeReason; goalContext: string } {
    const state = readRuntimeState(deps.projectRoot);
    const notes = drainSyntheticPlannerNotes(deps.projectRoot, `planner:${goalId}`).map(projectNote);
    const resumeReason = inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes });
    return { resumeReason, goalContext: renderContext(goalId, resumeReason, notes) };
    },
  };
  return coordinator;
}

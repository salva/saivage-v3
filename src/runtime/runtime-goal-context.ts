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
import type { RuntimeStampSource } from './runtime-config.js';

export class RuntimeGoalContextCoordinator {
  constructor(
    private readonly deps: {
      projectRoot: string;
      cards: RuntimeContextCardReader;
      sessionStamper: RuntimeStampSource;
    },
  ) {}

  inferResumeReason(goalId: string, fallback: GoalResumeReason = 'initial'): GoalResumeReason {
    const state = readRuntimeState(this.deps.projectRoot);
    const notes = this.buildGoalContextNotes(goalId);
    return inferGoalResumeReason({ goalId, fallback, activeRun: state?.active_card_run, notes });
  }

  buildGoalContextBlock(goalId: string, resumeReason: GoalResumeReason = 'initial'): string {
    const state = readRuntimeState(this.deps.projectRoot);
    const payload = buildGoalContextPayload({
      goalId,
      resumeReason,
      cards: this.deps.cards,
      notes: this.buildGoalContextNotes(goalId),
      activeRun: state?.active_card_run?.card_id === goalId ? state.active_card_run : null,
    });
    return renderGoalContextBlock({ goalId, resumeReason, payload });
  }

  appendPlannerResumeContext(
    goalId: string,
    plannerSessionId: string,
    resumeReason: GoalResumeReason,
  ): void {
    appendMessage(
      join(this.deps.projectRoot, '.saivage'),
      plannerSessionId,
      { role: 'user', kind: 'text', content: this.buildGoalContextBlock(goalId, resumeReason) },
      this.deps.sessionStamper.stampUserMessage(plannerSessionId),
      this.deps.sessionStamper,
    );
  }

  injectQueuedPlannerNotes(plannerSessionId: string): void {
    injectQueuedSyntheticPlannerNotes(this.deps.projectRoot, plannerSessionId, {
      stampUserMessage: (sessionId) => this.deps.sessionStamper.stampUserMessage(sessionId),
    });
  }

  private buildGoalContextNotes(goalId: string): Array<Record<string, unknown>> {
    return drainSyntheticPlannerNotes(this.deps.projectRoot, `planner:${goalId}`).map((note) => ({
      kind: note.kind,
      origin_card_id: note.affected_card_id,
      descendant_card_ids: note.descendant_card_ids,
      body: note.summary,
      at: note.created_at,
    }));
  }
}

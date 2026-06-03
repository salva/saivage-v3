import { describe, expect, it } from '@jest/globals';
import { ReviewerPhaseRunner } from '../../src/runtime/phases/reviewer-phase-runner.js';
import type { AgentExecutionPort, ReviewerInvocationRequest } from '../../src/contracts/index.js';
import type { CardRecord } from '../../src/schemas/types.js';

describe('ReviewerPhaseRunner', () => {
  it('builds reviewer prompt with skills and goal evidence before invocation', async () => {
    let request: ReviewerInvocationRequest | null = null;
    let started = false;
    const agentRuntime = {
      async invokeReviewer(input: ReviewerInvocationRequest) {
        request = input;
        return { assessment: { result: 'pass', summary: 'ok', achieved: [], issues: [], evidence_card_ids: ['goal-a'] } };
      },
    } as unknown as AgentExecutionPort;

    const runner = new ReviewerPhaseRunner({
      agentRuntime,
      skillsEngine: {
        loadPlannerInstructions: async () => '',
        loadInstructions: async () => 'reviewer instructions',
        selectAndFormat: async () => 'reviewer skill',
      },
      readGoalCard: () => ({ id: 'goal-a', description: 'Goal', tags: ['review'] }) as unknown as CardRecord,
      buildGoalContextBlock: () => '## Goal Context\ncontext',
      buildGoalEvidenceContext: () => '{"evidence":true}',
      markReviewerStarted: async () => {
        started = true;
      },
    });

    await runner.run({ goalId: 'goal-a', assessmentId: 'assessment-a', reviewerSessionId: 'reviewer-a' });

    const captured = request as ReviewerInvocationRequest | null;
    expect(started).toBe(true);
    expect(captured).toEqual(expect.objectContaining({ goalId: 'goal-a', assessmentId: 'assessment-a', reviewerSessionId: 'reviewer-a' }));
    expect(captured?.systemPrompt).toContain('reviewer instructions');
    expect(captured?.systemPrompt).toContain('reviewer skill');
    expect(captured?.systemPrompt).toContain('## Goal Context');
    expect(captured?.systemPrompt).toContain('## Goal Evidence Context');
  });
});

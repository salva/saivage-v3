import { describe, expect, it } from '@jest/globals';
import { PlannerPhaseRunner } from '../../src/runtime/phases/planner-phase-runner.js';
import type { AgentExecutionPort, PlannerInvocationRequest } from '../../src/contracts/index.js';
import type { CardRecord } from '../../src/schemas/types.js';

describe('PlannerPhaseRunner', () => {
  it('builds planner prompt with skills, goal context, and handoff before invocation', async () => {
    let request: PlannerInvocationRequest | null = null;
    let injected = false;
    const runner = new PlannerPhaseRunner({
      agentRuntime: {
        invokePlanner(input: PlannerInvocationRequest) {
          request = input;
          return { status: 'blocked', blocked_reason: 'waiting', created_cards: [], updated_cards: [] };
        },
      } as unknown as AgentExecutionPort,
      skillsEngine: {
        loadPlannerInstructions: async () => 'planner instructions',
        loadInstructions: async () => '',
        selectAndFormat: async () => 'planner skill',
      },
      maxDepth: 3,
      readGoalCard: () => ({ id: 'goal-a', depth: 0, description: 'Goal', tags: [] }) as unknown as CardRecord,
      buildGoalEvidenceContext: () => '{"children":[]}',
      buildGoalContextBlock: () => '## Goal Context\ncontext',
      inferResumeReason: () => 'initial',
      consumeResumeHandoffContext: () => 'handoff',
      injectSyntheticPlannerNotes: () => {
        injected = true;
      },
    });

    await runner.run({ goalId: 'goal-a', iteration: 0 });

    const captured = request as PlannerInvocationRequest | null;
    expect(injected).toBe(true);
    expect(captured).toEqual(expect.objectContaining({ goalId: 'goal-a' }));
    expect(captured?.systemPrompt).toContain('planner instructions');
    expect(captured?.systemPrompt).toContain('planner skill');
    expect(captured?.systemPrompt).toContain('## Goal Context');
    expect(captured?.systemPrompt).toContain('## Parent Resume Context');
  });
});

import { describe, expect, it } from '@jest/globals';
import { PlannerPhaseRunner } from '../../src/runtime/phases/planner-phase-runner.js';
import type { AgentExecutionPort, PlannerInvocationRequest } from '../../src/contracts/index.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { MatchParams } from '../../src/agents/skills-engine.js';

describe('PlannerPhaseRunner', () => {
  it('builds planner prompt with skills and goal context before invocation', async () => {
    let request: PlannerInvocationRequest | null = null;
    let skillMatchParams: MatchParams | null = null;
    let injected = false;
    const runner = new PlannerPhaseRunner({
      agentRuntime: {
        invokePlanner(input: PlannerInvocationRequest) {
          request = input;
          return { status: 'blocked', blocked_reason: 'waiting' };
        },
      } as unknown as AgentExecutionPort,
      skillsEngine: {
        loadPlannerInstructions: async () => 'planner instructions',
        loadInstructions: async () => '',
        selectAndFormat: async (params: MatchParams) => {
          skillMatchParams = params;
          return 'planner skill';
        },
      },
      maxDepth: 3,
      readGoalCard: () => ({
        id: 'goal-a',
        depth: 0,
        title: 'Build planner compaction',
        description: 'Goal',
        acceptance: 'Must keep card instructions',
        status_text: 'Needs source-specific policy',
        instructions_file: 'docs/planner.md',
        tags: ['runtime'],
      }) as unknown as CardRecord,
      buildGoalEvidenceContext: () => '{"children":[]}',
      buildPlannerGoalContext: () => ({ resumeReason: 'initial', goalContext: '## Goal Context\ncontext' }),
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
    const capturedSkillMatchParams = skillMatchParams as MatchParams | null;
    expect(capturedSkillMatchParams?.goalDescription).toContain('Build planner compaction');
    expect(capturedSkillMatchParams?.goalDescription).toContain('Must keep card instructions');
    expect(capturedSkillMatchParams?.goalDescription).toContain('docs/planner.md');
    expect(capturedSkillMatchParams?.cardDescription).toBe(capturedSkillMatchParams?.goalDescription);
  });
});

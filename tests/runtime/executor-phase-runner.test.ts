import { describe, expect, it } from '@jest/globals';
import { ExecutorPhaseRunner } from '../../src/runtime/phases/executor-phase-runner.js';
import type { AgentExecutionPort, ExecutorInvocationRequest } from '../../src/contracts/index.js';
import type { CardRecord } from '../../src/schemas/types.js';

const card = {
  id: 'card-a',
  type: 'code',
  description: 'Implement feature',
  tags: ['ts'],
} as unknown as CardRecord;

const goalCard = { id: 'goal-a', description: 'Build product' } as unknown as CardRecord;

describe('ExecutorPhaseRunner', () => {
  it('builds executor prompt with skills and card context before invocation', async () => {
    let request: ExecutorInvocationRequest | null = null;
    const agentRuntime = {
      invokeExecutor(input: ExecutorInvocationRequest) {
        request = input;
        return { card_id: input.cardId, status: 'done', status_text: 'Done' };
      },
    } as unknown as AgentExecutionPort;

    const runner = new ExecutorPhaseRunner({
      agentRuntime,
      skillsEngine: {
        loadPlannerInstructions: async () => '',
        loadInstructions: async () => 'executor instructions',
        selectAndFormat: async () => 'selected skill',
      },
      buildCardContextBlock: () => '## Card Context\ncontext',
    });

    await runner.run({ card, goalId: 'goal-a', goalCard });

    const captured = request as ExecutorInvocationRequest | null;
    expect(captured).toEqual(expect.objectContaining({ cardId: 'card-a', goalId: 'goal-a' }));
    expect(captured?.systemPrompt).toContain('executor instructions');
    expect(captured?.systemPrompt).toContain('selected skill');
    expect(captured?.systemPrompt).toContain('## Card Context');
  });
});

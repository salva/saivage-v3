import type { AgentExecutionPort, ReviewerResult } from '../../contracts/index.js';
import { createReviewerContract } from '../../contracts/reviewer-contract.js';
import { buildReviewerPrompt } from '../../agents/prompts/system-prompt.js';
import type { CardRecord } from '../../schemas/index.js';
import type { RuntimeSkillsPort } from '../runtime-config.js';

export interface ReviewerPhaseRunnerDeps {
  agentRuntime: AgentExecutionPort;
  skillsEngine: RuntimeSkillsPort | null;
  readGoalCard(goalId: string): CardRecord | null | undefined;
  buildGoalContextBlock(goalId: string): string;
  buildGoalEvidenceContext(goalId: string): string;
  markReviewerStarted(input: { goalId: string; reviewerSessionId: string; goalCard: CardRecord | null | undefined }): Promise<void>;
}

export class ReviewerPhaseRunner {
  constructor(private readonly deps: ReviewerPhaseRunnerDeps) {}

  async run(input: { goalId: string; assessmentId: string; reviewerSessionId: string }): Promise<ReviewerResult> {
    const reviewerContract = createReviewerContract();
    let reviewerPrompt = buildReviewerPrompt(reviewerContract);
    try {
      if (this.deps.skillsEngine) {
        const goalCard = this.deps.readGoalCard(input.goalId);
        const instructionContent = await this.deps.skillsEngine.loadInstructions('reviewer');
        const skillsContent = await this.deps.skillsEngine.selectAndFormat({
          goalDescription: goalCard?.description ?? '',
          cardDescription: goalCard?.description ?? '',
          tags: goalCard?.tags ?? [],
          filePaths: [],
          availableTools: ['glob', 'grep', 'read', 'skill', 'websearch', 'webfetch', 'mcp_tool_call'],
          targetRole: 'reviewer',
        });
        const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\n\n');
        if (combinedSkills) reviewerPrompt = buildReviewerPrompt(reviewerContract, combinedSkills);
      }
    } catch {
      void 0;
    }
    reviewerPrompt += `\n\n${this.deps.buildGoalContextBlock(input.goalId)}\n\n## Goal Evidence Context\n${this.deps.buildGoalEvidenceContext(input.goalId)}`;
    const goalCard = this.deps.readGoalCard(input.goalId);
    await this.deps.markReviewerStarted({ goalId: input.goalId, reviewerSessionId: input.reviewerSessionId, goalCard });
    const result = await this.deps.agentRuntime.invokeReviewer({
      goalId: input.goalId,
      systemPrompt: reviewerPrompt,
      contextMessages: [],
      assessmentId: input.assessmentId,
      reviewerSessionId: input.reviewerSessionId,
      contract: reviewerContract,
    });
    return result;
  }
}

import type { AgentExecutionPort, PlannerActivationBarrier, PlannerResult } from '../../contracts/index.js';
import { createPlannerContract } from '../../contracts/planner-contract.js';
import { buildPlannerPrompt } from '../../agents/prompts/system-prompt.js';
import type { CardRecord } from '../../schemas/index.js';
import type { GoalResumeReason } from '../goal-context.js';
import type { RuntimeSkillsPort } from '../runtime-config.js';

export interface PlannerPhaseRunnerDeps {
  agentRuntime: AgentExecutionPort;
  skillsEngine: RuntimeSkillsPort | null;
  maxDepth: number;
  readGoalCard(goalId: string): CardRecord | null | undefined;
  buildGoalEvidenceContext(goalId: string): string;
  buildGoalContextBlock(goalId: string, resumeReason: GoalResumeReason): string;
  inferResumeReason(goalId: string, fallback: GoalResumeReason): GoalResumeReason;
  injectSyntheticPlannerNotes(goalId: string): void;
  activationBarrier?: PlannerActivationBarrier;
}

export class PlannerPhaseRunner {
  constructor(private readonly deps: PlannerPhaseRunnerDeps) {}

  async run(input: { goalId: string; iteration: number }): Promise<PlannerResult> {
    const goalCard = this.deps.readGoalCard(input.goalId);
    const currentDepth = goalCard?.depth;
    const plannerContract = createPlannerContract({ goalId: input.goalId, parentSessionId: `planner:${input.goalId}` });
    const resumeContext = this.deps.buildGoalEvidenceContext(input.goalId);
    const resumeReason = this.deps.inferResumeReason(input.goalId, input.iteration === 0 ? 'initial' : 'reviewer_correction');
    const goalContext = this.deps.buildGoalContextBlock(input.goalId, resumeReason);
    let plannerPrompt = buildPlannerPrompt(plannerContract, undefined, currentDepth, this.deps.maxDepth);
    plannerPrompt += `\n\n${goalContext}\n\n## Parent Resume Context\n${resumeContext}`;
    try {
      if (goalCard && this.deps.skillsEngine) {
        const plannerInstr =
          goalCard.depth === 0
            ? await this.deps.skillsEngine.loadPlannerInstructions()
            : goalCard.instructions_file && goalCard.instructions_file.trim()
              ? await this.deps.skillsEngine.loadPlannerInstructions(goalCard.instructions_file.trim())
              : '';
        const currentCardContract = [
          `title: ${goalCard.title}`,
          `description: ${goalCard.description}`,
          goalCard.acceptance ? `acceptance: ${goalCard.acceptance}` : '',
          goalCard.status_text ? `status_text: ${goalCard.status_text}` : '',
          goalCard.instructions_file ? `instructions_file: ${goalCard.instructions_file}` : '',
        ].filter(Boolean).join('\n');
        const skillsContent = await this.deps.skillsEngine.selectAndFormat({
          goalDescription: currentCardContract,
          cardDescription: currentCardContract,
          tags: goalCard.tags,
          filePaths: [],
          availableTools: ['glob', 'grep', 'read', 'write', 'edit', 'apply_patch', 'websearch', 'webfetch', 'mcp_tool_call'],
          targetRole: 'planner',
        });
        const combinedSkills = [plannerInstr, skillsContent].filter(Boolean).join('\n\n');
        if (combinedSkills) {
          plannerPrompt =
            buildPlannerPrompt(plannerContract, combinedSkills, currentDepth, this.deps.maxDepth) +
            `\n\n${goalContext}\n\n## Parent Resume Context\n${resumeContext}`;
        }
      }
    } catch {
      void 0;
    }
    this.deps.injectSyntheticPlannerNotes(input.goalId);
    const result = this.deps.agentRuntime.invokePlanner({ goalId: input.goalId, systemPrompt: plannerPrompt, contract: plannerContract, activationBarrier: this.deps.activationBarrier });
    return result instanceof Promise ? await result : result;
  }
}

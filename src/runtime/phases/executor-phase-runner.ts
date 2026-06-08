import type { AgentExecutionPort, ExecutorResult } from '../../contracts/index.js';
import { createExecutorContract } from '../../contracts/executor-contract.js';
import { buildExecutorPrompt } from '../../agents/prompts/system-prompt.js';
import type { CardRecord } from '../../schemas/index.js';
import type { RuntimeSkillsPort } from '../runtime-config.js';

export interface ExecutorPhaseRunnerDeps {
  agentRuntime: AgentExecutionPort;
  skillsEngine: RuntimeSkillsPort | null;
  buildCardContextBlock(cardId: string, goalId: string): string;
}

export class ExecutorPhaseRunner {
  constructor(private readonly deps: ExecutorPhaseRunnerDeps) {}

  async run(input: { card: CardRecord; goalId: string; goalCard: CardRecord | null | undefined }): Promise<ExecutorResult> {
    const executorContract = createExecutorContract();
    let executorPrompt = buildExecutorPrompt(executorContract, input.card.type);
    try {
      if (this.deps.skillsEngine) {
        const instructionContent = await this.deps.skillsEngine.loadInstructions('executor');
        const skillsContent = await this.deps.skillsEngine.selectAndFormat({
          goalDescription: input.goalCard?.description ?? '',
          cardDescription: input.card.description,
          tags: input.card.tags,
          filePaths: [],
          availableTools: [
            'glob',
            'grep',
            'read',
            'write',
            'edit',
            'apply_patch',
            'run_project_command',
            'skill',
            'websearch',
            'webfetch',
            'mcp_tool_call',
          ],
          targetRole: 'executor',
        });
        const combinedSkills = [instructionContent, skillsContent].filter(Boolean).join('\n\n');
        if (combinedSkills) executorPrompt = buildExecutorPrompt(executorContract, input.card.type, combinedSkills);
      }
    } catch {
      void 0;
    }
    executorPrompt += `\n\n${this.deps.buildCardContextBlock(input.card.id, input.goalId)}`;
    const result = this.deps.agentRuntime.invokeExecutor({
      cardId: input.card.id,
      goalId: input.goalId,
      systemPrompt: executorPrompt,
      contract: executorContract,
    });
    return result instanceof Promise ? await result : result;
  }
}

import type { AgentName } from '../schemas/index.js';
import { skillInputSchema } from '../contracts/builtin-tool-inputs.js';
import { defineToolBinder, executeToolAction, OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE, type ToolBinder } from './invocation.js';
import { SkillCatalog } from './skill-catalog.js';

export interface SkillProviderContext {
  readonly projectRoot: string;
  readonly agentName: AgentName;
}

export const skillToolBinders: readonly ToolBinder<SkillProviderContext, any>[] = Object.freeze([
  defineToolBinder({
    name: 'skill',
    description: 'List role-available skills or load one role-available skill on demand during an agent session. Omit name to list skill names; provide name to load exact skill content.',
    resultPolicyTemplate: OBSERVATIONAL_READ_RESULT_POLICY_TEMPLATE,
    inputSchema: () => skillInputSchema,
    executor: (ctx, args) => executeToolAction('observational_query', async () => {
      const catalog = new SkillCatalog(ctx.projectRoot);
      try {
        if (args.name === undefined) return { success: true, data: { skills: catalog.list(ctx.agentName) } };
        const skill = catalog.read(ctx.agentName, args.name);
        return { success: true, data: { skill_name: skill.name, skill_content: skill.content } };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  }),
]);

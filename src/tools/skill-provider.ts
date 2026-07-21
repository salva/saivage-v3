import { z } from 'zod';

import type { SkillTargetRole } from '../schemas/index.js';
import { defineTool, type ToolProvider } from './invocation.js';
import { SkillCatalog } from './skill-catalog.js';

export interface SkillProviderContext {
  readonly projectRoot: string;
  readonly agentRole: SkillTargetRole;
}

const skillSchema = z.object({ name: z.string().optional() }).strict();

export function createSkillProvider(ctx: SkillProviderContext): ToolProvider {
  const catalog = new SkillCatalog(ctx.projectRoot);
  return {
    providerName: 'skill',
    tools: [
      defineTool({
        name: 'skill',
        description: 'List role-available skills or load one role-available skill on demand during an agent session. Omit name to list skill names; provide name to load exact skill content.',
        inputSchema: skillSchema,
        executor: async (args) => {
          try {
            if (args.name === undefined) {
              return { success: true, data: { skills: catalog.list(ctx.agentRole) } };
            }
            const skill = catalog.read(ctx.agentRole, args.name);
            return { success: true, data: { skill_name: skill.name, skill_content: skill.content } };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  };
}

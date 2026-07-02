import { z } from 'zod';

import { loadSkill } from '../agents/skill-tools.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import { defineTool, type ToolProvider } from './invocation.js';

export interface SkillProviderContext {
  readonly projectRoot: string;
  readonly agentRole: 'executor' | 'reviewer' | 'analyst';
  readonly skillsEngine?: SkillsEngine;
}

const skillSchema = z.object({ name: z.string().optional() }).strict();

export function createSkillProvider(ctx: SkillProviderContext): ToolProvider {
  const engine = ctx.skillsEngine ?? new SkillsEngine({ projectRoot: ctx.projectRoot });
  return {
    providerName: 'skill',
    tools: [
      defineTool({
        name: 'skill',
        description: 'List available skills or load one skill on-demand during an agent session. Omit name to list compact skill metadata; provide name to load full skill content.',
        inputSchema: skillSchema,
        executor: async (args) => {
          try {
            if (!args.name) {
              const skills = engine.loadIndex()
                .filter((entry) => entry.target_agents.includes(ctx.agentRole))
                .map((entry) => ({ name: entry.name, target_agents: entry.target_agents, triggers: entry.triggers }));
              return { success: true, data: { skills } };
            }
            return { success: true, data: await loadSkill(args.name, ctx.agentRole, engine) };
          } catch (error) {
            return { success: false, error: error instanceof Error ? error.message : String(error) };
          }
        },
      }),
    ],
  };
}

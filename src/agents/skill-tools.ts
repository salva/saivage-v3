/**
 * Skill Tools — Implements the load_skill MCP tool for on-demand skill loading
 * per 07-skills.md §On-Demand Loading.
 *
 * When an agent determines it needs a skill that was not preloaded (e.g., it
 * encounters an unfamiliar framework mid-task), it can call load_skill(name)
 * to request that skill be loaded and injected into the conversation.
 */

import { SkillsEngine } from './skills-engine.js';
import type { ToolDefinition } from './llm-client.js';

// ── Types ─────────────────────────────────────────────────────

/**
 * Result returned by a successful loadSkill() call.
 */
export interface SkillToolsResult {
  skill_name: string;
  skill_content: string;
  loaded: true;
}

// ── Error ─────────────────────────────────────────────────────

/**
 * Error thrown when load_skill fails due to permission or lookup issues.
 */
export class LoadSkillError extends Error {
  public readonly name = 'LoadSkillError';

  constructor(message: string) {
    super(message);
    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, LoadSkillError.prototype);
  }
}

// ── Constants ─────────────────────────────────────────────────

/**
 * Agent roles that are permitted to call load_skill.
 * Per 07-skills.md: the runtime exposes load_skill to planner, executor,
 * and reviewer agents. The analyst can request skills by other means.
 */
export const PERMITTED_ROLES: readonly string[] = [
  'planner',
  'executor',
  'reviewer',
] as const;

// ── Tool Definition ───────────────────────────────────────────

/**
 * OpenAI function-calling tool definition for the load_skill tool.
 *
 * Agents (planner, executor, reviewer) can invoke this tool mid-session
 * to load a skill that was not preloaded via trigger matching.
 *
 * The tool accepts a single required parameter:
 * - name: The name of the skill to load (must match an entry in the skills index)
 */
export const LOAD_SKILL_TOOL_DEFINITION: ToolDefinition = {
  type: 'function',
  function: {
    name: 'load_skill',
    description:
      'Load a skill on-demand during an agent session. Skills provide domain-specific instructions, coding standards, or project conventions. Use this when you encounter a situation that requires a skill not already in your context. Provide the skill name to load its content.',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description:
            'The name of the skill to load (must match an entry in the skills index)',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
};

/**
 * Convenience array containing the load_skill tool definition.
 * Use this when constructing the tools list for an LLM call.
 */
export const LOAD_SKILL_TOOL_DEFINITIONS: ToolDefinition[] = [
  LOAD_SKILL_TOOL_DEFINITION,
];

// ── Delimited Block Format ────────────────────────────────────

/**
 * Format a skill's content as a delimited block matching the format used
 * by SkillsEngine.formatSkills() and described in 07-skills.md:
 *
 * ```
 * --- SKILL: <name> ---
 * <content>
 * --- END SKILL ---
 * ```
 */
function formatSkillBlock(name: string, content: string): string {
  return `--- SKILL: ${name} ---\n${content}\n--- END SKILL ---`;
}

// ── Main Tool ─────────────────────────────────────────────────

/**
 * Load a skill on-demand during an agent session.
 *
 * This implements the `load_skill(name)` MCP tool described in
 * 07-skills.md §On-Demand Loading. Agents call it when they need a
 * skill that was not pre-loaded via trigger-based matching.
 *
 * @param name - The skill name to look up (must match an entry in the index)
 * @param role - The calling agent's role (must be in PERMITTED_ROLES)
 * @param skillsEngine - The SkillsEngine instance to use for lookup and loading
 * @returns A SkillToolsResult with the formatted skill content
 * @throws {LoadSkillError} If the role is not permitted or the skill is not found
 */
export async function loadSkill(
  name: string,
  role: string,
  skillsEngine: SkillsEngine,
): Promise<SkillToolsResult> {
  // Validate role permission
  if (!PERMITTED_ROLES.includes(role)) {
    throw new LoadSkillError(
      `Role '${role}' is not permitted to load skills. ` +
        `Only ${PERMITTED_ROLES.join(', ')} can call load_skill.`,
    );
  }

  // Look up skill in the index
  const index = skillsEngine.loadIndex();
  const entry = index.find((e) => e.name === name);
  if (!entry) {
    throw new LoadSkillError(`Skill '${name}' not found in index`);
  }

  // Load the skill file contents via SkillsEngine
  // (getSkillFile will throw its own Error if the file is missing,
  // per its documented behavior. We let that propagate naturally.)
  const content = await skillsEngine.getSkillFile(name);

  // Format as a delimited block matching the pre-loaded skill format
  const skill_content = formatSkillBlock(name, content);

  return {
    skill_name: name,
    skill_content,
    loaded: true,
  };
}

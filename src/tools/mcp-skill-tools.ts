import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';

export const mcpAndSkillTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'load_skill', description: 'Load a skill on-demand during an agent session. Skills provide domain-specific instructions, coding standards, or project conventions. Use this when you encounter a situation that requires a skill not already in your context. Provide the skill name to load its content.', input: z.object({ name: describe(z.string(), 'The name of the skill to load (must match an entry in the skills index)') }).strict(), roles: ['executor', 'reviewer'], skill: true },
  { name: 'mcp_tool_call', description: 'Call an MCP (Model Context Protocol) tool on a configured MCP server. MCP tools provide access to git operations, filesystem tools, databases, package registries, and other external capabilities. Provide the server name, tool name, and optional arguments to invoke the tool. Results are returned as tool_result content.', input: z.object({ serverName: z.string(), toolName: z.string(), args: z.record(z.unknown()).optional() }).strict(), roles: ['executor', 'reviewer'], mcpWrapper: true },
] as const;

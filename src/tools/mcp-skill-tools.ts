import { z } from 'zod';

import { describe, type UnifiedToolDefinition } from './tool-catalog.js';

export const mcpAndSkillTools: readonly UnifiedToolDefinition<string, any>[] = [
  { name: 'skill', description: 'List available skills or load one skill on-demand during an agent session. Omit name to list compact skill metadata; provide name to load full skill content.', input: z.object({ name: describe(z.string().optional(), 'Optional skill name to load. Omit to list available skills.') }).strict(), roles: ['executor', 'reviewer'], skill: true },
  { name: 'mcp_tool_call', description: 'Call an MCP (Model Context Protocol) tool on a configured MCP server. MCP tools provide access to git operations, filesystem tools, databases, package registries, and other external capabilities. Provide the server name, tool name, and optional arguments to invoke the tool. Results are returned as tool_result content.', input: z.object({ serverName: z.string(), toolName: z.string(), args: z.record(z.unknown()).optional() }).strict(), roles: ['executor', 'reviewer'], mcpWrapper: true },
] as const;

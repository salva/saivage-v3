import type { ToolDefinition } from './llm-contracts.js';
import {
  ALL_TOOL_DEFINITIONS_BY_NAME,
  MCP_WRAPPER_TOOL_NAMES,
  PLANNER_CONTROL_TOOL_NAMES,
  PLANNER_TOOL_DEFINITIONS,
  SKILL_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
  allRoleToolNames,
  toolNamesForRole,
} from '../tools/definitions/index.js';

export {
  ALL_TOOL_DEFINITIONS_BY_NAME,
  MCP_WRAPPER_TOOL_NAMES,
  PLANNER_CONTROL_TOOL_NAMES,
  PLANNER_TOOL_DEFINITIONS,
  SKILL_TOOL_NAMES,
  WORKSPACE_TOOL_NAMES,
} from '../tools/definitions/index.js';

export const ROLE_TOOL_NAMES = allRoleToolNames();

export class AgentToolCatalog {
  static roleToolNames(role: keyof typeof ROLE_TOOL_NAMES): string[] {
    return toolNamesForRole(role);
  }
  static isPlannerTool(name: string): boolean {
    return toolNamesForRole('planner').includes(name);
  }
  static isPlannerControlTool(name: string): boolean {
    return PLANNER_CONTROL_TOOL_NAMES.has(name);
  }
  static isWorkspaceTool(name: string): boolean {
    return WORKSPACE_TOOL_NAMES.has(name);
  }
  static definitionFor(name: string): ToolDefinition | undefined {
    return ALL_TOOL_DEFINITIONS_BY_NAME.get(name);
  }
}

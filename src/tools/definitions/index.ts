import type { ToolDefinition as LlmToolDefinition } from '../../agents/llm-contracts.js';
import { z } from 'zod';
import { zodToJsonSchemaMini } from '../../agents/zod-to-jsonschema-mini.js';
import type { PermissionRole } from '../../permissions/index.js';
import { defineTool, type JsonSchemaObject, type ToolDefinition as RuntimeToolDefinition } from '../runtime.js';
import { analystCardTools } from '../analyst-card-tools.js';
import { analystSubtreeTools } from '../analyst-subtree-tools.js';
import { analystRuntimeTools } from '../analyst-runtime-tools.js';
import { analystWorkspaceTools } from '../analyst-workspace-tools.js';
import { analystMiscTools } from '../analyst-misc-tools.js';
import { workspaceRuntimeTools } from '../workspace-tools.js';
import { plannerControlTools } from '../planner-control-tools.js';
import { mcpAndSkillTools } from '../mcp-skill-tools.js';
import { webTools } from '../web-tools.js';
import type { ToolContext, ToolResult } from '../analyst-tool-types.js';
import type { AgentRole, UnifiedToolDefinition } from '../tool-catalog.js';

export {
  ANALYST_ISSUE_SEVERITY_VALUES,
  CARD_STATUS_VALUES,
  CARD_TYPE_VALUES,
  CREATE_CARD_TYPE_VALUES,
  NOTE_KIND_VALUES,
  PLANNER_CREATE_CARD_TYPE_VALUES,
  RUNTIME_CARD_STATUS_VALUES,
  URGENCY_VALUES,
  analystIssueSeveritySchema,
  cardIdArraySchema,
  cardStatusSchema,
  cardTypeSchema,
  describe,
  emptyInput,
  enumSchema,
  plannerCreateCardTypeSchema,
  runtimeCardStatusSchema,
  stringArraySchema,
  urgencySchema,
  type AgentRole,
  type ToolExecutor,
  type UnifiedToolDefinition,
} from '../tool-catalog.js';

const aggregatedToolDefinitions = [
  ...analystCardTools,
  ...analystSubtreeTools,
  ...analystRuntimeTools,
  ...analystWorkspaceTools,
  ...analystMiscTools,
  ...workspaceRuntimeTools,
  ...webTools,
  ...plannerControlTools,
  ...mcpAndSkillTools,
] as const;

const stableToolOrder = [
  'mark_goal_needs_corrections',
  'create_card',
  'edit_card',
  'reorder_child',
  'queue_notification',
  'list_cards',
  'get_card',
  'get_tree',
  'get_status',
  'skill',
  'list_card_history',
  'get_card_history_entry',
  'diff_card',
  'start_project',
  'stop_project',
  'pause_runtime',
  'resume_runtime',
  'abort_goal_subtree',
  'restart_card_or_subtree',
  'restart_goal',
  'navigate_workspace',
  'navigate_back',
  'show_config',
  'restart_server',
  'reconfigure',
  'read_runtime_events',
  'read_runtime_errors',
  'read_control_actions',
  'list_processes_tool',
  'list_agent_sessions',
  'read_agent_session',
  'read',
  'write',
  'glob',
  'grep',
  'edit',
  'apply_patch',
  'run_command',
  'wait_process',
  'kill_process',
  'websearch',
  'webfetch',
  'mcp_tool_call',
  'activate_card',
  'cancel_card',
  'delete_card',
  'restart_card',
  'report_goal_done',
  'report_goal_failed',
  'report_goal_blocked',
] as const;

const aggregatedByName = new Map<string, UnifiedToolDefinition>(aggregatedToolDefinitions.map((tool) => [tool.name, tool]));
export const TOOL_DEFINITIONS = stableToolOrder.map((name) => {
  const tool = aggregatedByName.get(name);
  if (!tool) throw new Error(`Missing tool definition for ${name}`);
  return tool;
});

const toolResultSchema = z.custom<ToolResult>((value) => Boolean(value && typeof value === 'object' && 'success' in value && typeof (value as { success?: unknown }).success === 'boolean'));
const byName = new Map<string, UnifiedToolDefinition>(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

function schemaFor(tool: UnifiedToolDefinition): JsonSchemaObject {
  return zodToJsonSchemaMini(tool.input) as JsonSchemaObject;
}

export function llmToolDefinition(tool: UnifiedToolDefinition): LlmToolDefinition {
  return { type: 'function', function: { name: tool.name, description: tool.description, parameters: schemaFor(tool) } };
}

export function toolDefinitionByName(name: string): UnifiedToolDefinition | undefined {
  return byName.get(name);
}

export const ANALYST_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.roles.includes('analyst') && !tool.workspace).map(llmToolDefinition);
export const ANALYST_TOOL_NAMES = ANALYST_TOOL_DEFINITIONS.map((tool) => tool.function.name);
export const READ_ONLY_WORKSPACE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.workspace && !['write', 'edit', 'apply_patch', 'run_command', 'wait_process', 'kill_process'].includes(tool.name)).map(llmToolDefinition);
export const WORKSPACE_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.workspace).map(llmToolDefinition);
export const PLANNER_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.roles.includes('planner') && !tool.skill && !tool.mcpWrapper).map((tool) => {
  if (tool.plannerInput) return llmToolDefinition({ ...tool, description: tool.plannerDescription ?? tool.description, input: tool.plannerInput, roles: ['planner'] });
  return llmToolDefinition(tool);
}).filter((tool, index, all) => all.findIndex((candidate) => candidate.function.name === tool.function.name) === index);

export const PLANNER_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.plannerControl || ['create_card', 'edit_card', 'reorder_child', 'queue_notification'].includes(tool.name)).map((tool) => tool.name));
export const WORKSPACE_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.workspace).map((tool) => tool.name));
export const SKILL_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.skill).map((tool) => tool.name));
export const MCP_WRAPPER_TOOL_NAMES: ReadonlySet<string> = new Set(TOOL_DEFINITIONS.filter((tool) => tool.mcpWrapper).map((tool) => tool.name));

export function toolNamesForRole(role: AgentRole): string[] {
  return TOOL_DEFINITIONS.filter((tool) => tool.roles.includes(role)).map((tool) => tool.name);
}

export function allRoleToolNames(): Record<AgentRole, string[]> {
  return { planner: toolNamesForRole('planner'), executor: toolNamesForRole('executor'), reviewer: toolNamesForRole('reviewer'), analyst: toolNamesForRole('analyst'), operator: toolNamesForRole('operator') };
}

function actorForRole(role: PermissionRole, toolName?: string): ToolContext['actor'] {
  if (role === 'operator') return 'planner';
  if (role === 'planner' && toolName === 'edit_card') return 'runtime';
  return role;
}

export const AGENT_TOOL_DEFINITIONS = TOOL_DEFINITIONS.filter((tool) => tool.executor && !tool.plannerControl).map((tool) => defineTool({
  name: tool.name,
  description: tool.description,
  input: tool.input,
  output: toolResultSchema,
  parameters: schemaFor(tool),
  roles: tool.roles,
  execute: async (ctx, input) => tool.executor!({ projectRoot: ctx.projectRoot, store: ctx.cardStore, actor: actorForRole(ctx.role, tool.name), surface: ctx.surface, sessionId: ctx.sessionId }, input),
})) as readonly RuntimeToolDefinition<string, unknown, ToolResult>[];

export const ALL_TOOL_DEFINITIONS_BY_NAME = new Map<string, LlmToolDefinition>([
  ...TOOL_DEFINITIONS.map(llmToolDefinition),
  ...PLANNER_TOOL_DEFINITIONS,
].map((definition) => [definition.function.name, definition]));

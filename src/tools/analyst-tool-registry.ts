import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { analystCardTools } from './analyst-card-tools.js';
import { analystMiscTools } from './analyst-misc-tools.js';
import { analystRuntimeTools } from './analyst-runtime-tools.js';
import { analystWorkspaceTools } from './analyst-workspace-tools.js';
import type { UnifiedToolDefinition } from './tool-definition.js';

const analystToolOrder = [
  'create_card',
  'reorder_child',
  'queue_notification',
  'get_status',
  'start_project',
  'stop_project',
  'pause_runtime',
  'resume_runtime',
  'restart_server',
  'navigate_workspace',
  'navigate_back',
  'show_config',
  'reconfigure',
  'read_runtime_events',
  'read_runtime_errors',
  'read_control_actions',
  'list_processes_tool',
  'list_agent_sessions',
  'read_agent_session',
  'cancel_card',
  'delete_card',
] as const;

export const ANALYST_SHARED_PROVIDER_TOOL_NAMES = [
  'list_cards',
  'get_card',
  'get_tree',
  'list_card_history',
  'get_card_history_entry',
  'diff_card',
  'read',
  'write',
  'edit',
  'apply_patch',
  'glob',
  'grep',
  'run_command',
  'wait_process',
  'kill_process',
  'websearch',
  'webfetch',
  'skill',
  'mcp_tool_call',
] as const;

const analystDefinitions = [
  ...analystCardTools,
  ...analystRuntimeTools,
  ...analystWorkspaceTools,
  ...analystMiscTools,
] as const;

const analystByName = new Map<string, UnifiedToolDefinition>(analystDefinitions.map((tool) => [tool.name, tool]));

export const ANALYST_CONTROL_TOOLS: readonly UnifiedToolDefinition[] = analystToolOrder.map((name) => {
  const tool = analystByName.get(name);
  if (!tool) throw new Error(`Missing Analyst tool definition for ${name}`);
  if (!tool.roles.includes('analyst')) throw new Error(`Analyst tool '${name}' is not marked for the analyst role.`);
  return tool;
});

export const ANALYST_CONTROL_TOOL_NAMES: ReadonlySet<string> = new Set(ANALYST_CONTROL_TOOLS.map((tool) => tool.name));
export const ANALYST_TOOL_NAMES: readonly string[] = [...ANALYST_CONTROL_TOOLS.map((tool) => tool.name), ...ANALYST_SHARED_PROVIDER_TOOL_NAMES];

export function llmAnalystToolDefinition(tool: UnifiedToolDefinition): LlmToolDefinition {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: zodToJsonSchemaMini(tool.input),
    },
  };
}

export const ANALYST_TOOL_DEFINITIONS: readonly LlmToolDefinition[] = ANALYST_CONTROL_TOOLS.map(llmAnalystToolDefinition);

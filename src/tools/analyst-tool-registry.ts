import { analystCardTools } from './analyst-card-tools.js';
import { analystMiscTools } from './analyst-misc-tools.js';
import { analystRuntimeTools } from './analyst-runtime-tools.js';
import { analystWorkspaceTools } from './analyst-workspace-tools.js';
import type { ToolContext } from './analyst-tool-types.js';
import type { ToolDefinition } from './invocation.js';

const analystToolOrder = [
  'create_card',
  'reorder_child',
  'queue_notification',
  'get_status',
  'start_project',
  'pause_runtime',
  'resume_runtime',
  'stop_project',
  'restart_server',
  'navigate_workspace',
  'navigate_back',
  'show_config',
  'reconfigure',
  'mcp_reconcile',
  'read_runtime_events',
  'read_runtime_errors',
  'read_control_actions',
  'list_processes_tool',
  'list_agent_sessions',
  'read_agent_session',
  'cancel_card',
  'delete_card',
] as const;

export function createAnalystControlTools(ctx: ToolContext): readonly ToolDefinition<any>[] {
  const definitions = [
    ...analystCardTools(ctx),
    ...analystRuntimeTools(ctx),
    ...analystWorkspaceTools(ctx),
    ...analystMiscTools(ctx),
  ];
  const byName = new Map<string, ToolDefinition<any>>();
  for (const tool of definitions) {
    if (byName.has(tool.name)) throw new Error(`Duplicate Analyst tool definition for ${tool.name}`);
    byName.set(tool.name, tool);
  }
  return analystToolOrder.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Missing Analyst tool definition for ${name}`);
    return tool;
  });
}

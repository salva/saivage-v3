import { analystCardToolBinders } from './analyst-card-tools.js';
import { analystMiscToolBinders } from './analyst-misc-tools.js';
import { analystRuntimeToolBinders } from './analyst-runtime-tools.js';
import { analystNavigationToolBinders } from './analyst-workspace-tools.js';
import type { ToolContext } from './analyst-tool-types.js';
import type { ToolBinder, ToolDefinition } from './invocation.js';

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

let analystControlToolBinderCache: readonly ToolBinder<ToolContext, any>[] | null = null;

export function getAnalystControlToolBinders(): readonly ToolBinder<ToolContext, any>[] {
  if (analystControlToolBinderCache) return analystControlToolBinderCache;
  const definitions = [
    ...analystCardToolBinders,
    ...analystRuntimeToolBinders,
    ...analystNavigationToolBinders,
    ...analystMiscToolBinders,
  ];
  const byName = new Map<string, ToolBinder<ToolContext, any>>();
  for (const tool of definitions) {
    if (byName.has(tool.name)) throw new Error(`Duplicate Analyst tool definition for ${tool.name}`);
    byName.set(tool.name, tool);
  }
  analystControlToolBinderCache = Object.freeze(analystToolOrder.map((name) => {
    const tool = byName.get(name);
    if (!tool) throw new Error(`Missing Analyst tool definition for ${name}`);
    return tool;
  }));
  return analystControlToolBinderCache;
}

export function createAnalystControlTools(ctx: ToolContext): readonly ToolDefinition<any>[] {
  return getAnalystControlToolBinders().map((binder) => binder.bind(ctx));
}

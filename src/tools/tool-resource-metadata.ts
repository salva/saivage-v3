import type { CapabilityResource } from '../schemas/index.js';

export type ToolResourceMetadata = Readonly<{
  kinds: readonly CapabilityResource['kind'][];
  target: 'required' | 'optional' | 'none';
  directTarget:
    | 'card-selection'
    | 'parent'
    | 'bound-card'
    | 'record-selection'
    | 'workspace'
    | 'workspace-or-record'
    | 'none';
}>;
const cardTools = new Set([
  'list_cards',
  'get_card',
  'get_tree',
  'list_card_versions',
  'get_card_version',
  'diff_card_versions',
  'create_card',
  'edit_card',
  'activate_card',
  'reopen_card',
  'cancel_card',
  'delete_card',
  'reorder_child',
  'queue_notification',
  'checkpoint_source',
]);
const mixedTools = new Set(['read', 'glob', 'grep', 'write', 'edit']);
const workspaceTools = new Set(['apply_patch', 'view_image']);
const targetlessTools = new Set([
  'start_project',
  'pause_runtime',
  'resume_runtime',
  'stop_project',
  'restart_server',
  'read_control_actions',
  'get_status',
  'read_runtime_events',
  'read_runtime_errors',
  'list_processes_tool',
  'list_agent_sessions',
  'read_agent_session',
  'show_config',
  'reconfigure',
  'navigate_workspace',
  'navigate_back',
  'run_command',
  'wait_process',
  'kill_process',
  'websearch',
  'skill',
  'list_observed_collections',
  'query_observed_collections',
  'mcp_server_replace',
  'mcp_server_register',
  'mcp_server_unregister',
  'mcp_server_set_scope',
  'mcp_servers',
  'mcp_server_control',
  'mcp_tools',
  'mcp_catalog_refresh',
  'mcp_tool_call',
  'code_quality_javascript_eslint',
  'code_quality_typescript_eslint',
  'code_quality_python_ruff',
]);

/** Direct-object semantics only; actual binding availability remains catalog-owned. */
export function toolResourceMetadata(name: string): ToolResourceMetadata {
  if (cardTools.has(name))
    return Object.freeze({
      kinds: ['card'] as const,
      target: 'required',
      directTarget:
        name === 'create_card' || name === 'reorder_child'
          ? 'parent'
          : name === 'checkpoint_source'
            ? 'bound-card'
            : 'card-selection',
    });
  if (name === 'read_record_version')
    return Object.freeze({
      kinds: ['record'] as const,
      target: 'required',
      directTarget: 'record-selection',
    });
  if (mixedTools.has(name))
    return Object.freeze({
      kinds: ['record', 'workspace'] as const,
      target: 'required',
      directTarget: 'workspace-or-record',
    });
  if (workspaceTools.has(name))
    return Object.freeze({
      kinds: ['workspace'] as const,
      target: 'required',
      directTarget: 'workspace',
    });
  if (name === 'webfetch')
    return Object.freeze({
      kinds: ['record', 'workspace'] as const,
      target: 'optional',
      directTarget: 'workspace-or-record',
    });
  if (targetlessTools.has(name))
    return Object.freeze({ kinds: [], target: 'none', directTarget: 'none' });
  throw new Error(`Missing direct-object metadata for runtime tool '${name}'.`);
}

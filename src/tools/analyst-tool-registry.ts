import type { ToolDefinition as LlmToolDefinition } from '../agents/llm-contracts.js';
import { zodToJsonSchemaMini } from '../agents/zod-to-jsonschema-mini.js';
import { analystCardTools } from './analyst-card-tools.js';
import { analystMiscTools } from './analyst-misc-tools.js';
import { analystRuntimeTools } from './analyst-runtime-tools.js';
import { analystWorkspaceTools } from './analyst-workspace-tools.js';
import type { UnifiedToolDefinition } from './analyst-tool-definition.js';

const analystToolOrder = [
  'create_card',
  'reorder_child',
  'queue_notification',
  'get_status',
  'start_project',
  'pause_runtime',
  'resume_runtime',
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

export type AnalystToolEffectClass = 'read_only' | 'ordinary_mutation' | 'external_workspace_mutation' | 'external_process_mutation' | 'disposable_external_output' | 'rejection_only' | 'special_owner';
export interface AnalystToolEffectBranch { readonly branch: string; readonly effect: AnalystToolEffectClass; readonly owner: string; }

export const ANALYST_TOOL_EFFECT_INVENTORY: Readonly<Record<string, readonly AnalystToolEffectBranch[]>> = {
  create_card: [{ branch: 'all', effect: 'ordinary_mutation', owner: 'AnalystCardMutationService' }],
  reorder_child: [{ branch: 'all', effect: 'ordinary_mutation', owner: 'AnalystCardMutationService' }],
  queue_notification: [{ branch: 'all', effect: 'ordinary_mutation', owner: 'AnalystNotificationMutationService' }],
  get_status: [{ branch: 'all', effect: 'read_only', owner: 'read-model' }],
  start_project: [{ branch: 'all', effect: 'special_owner', owner: 'RuntimeControlService' }],
  pause_runtime: [{ branch: 'all', effect: 'special_owner', owner: 'RuntimeControlService' }],
  resume_runtime: [{ branch: 'all', effect: 'special_owner', owner: 'RuntimeControlService' }],
  restart_server: [{ branch: 'confirmation_intent', effect: 'read_only', owner: 'analyst-adapter' }, { branch: 'confirmed', effect: 'special_owner', owner: 'RestartPort' }],
  navigate_workspace: [{ branch: 'all', effect: 'read_only', owner: 'navigation-intent' }],
  navigate_back: [{ branch: 'all', effect: 'read_only', owner: 'navigation-intent' }],
  show_config: [{ branch: 'all', effect: 'read_only', owner: 'config-read-facet' }],
  reconfigure: [{ branch: 'non_mcp', effect: 'ordinary_mutation', owner: 'AnalystConfigMutationService' }, { branch: 'mcp_add_edit_remove', effect: 'rejection_only', owner: 'analyst-adapter' }],
  mcp_reconcile: [{ branch: 'all', effect: 'rejection_only', owner: 'analyst-adapter' }],
  read_runtime_events: [{ branch: 'all', effect: 'read_only', owner: 'app-log-read-facet' }],
  read_runtime_errors: [{ branch: 'all', effect: 'read_only', owner: 'app-log-read-facet' }],
  read_control_actions: [{ branch: 'all', effect: 'read_only', owner: 'app-log-read-facet' }],
  list_processes_tool: [{ branch: 'all', effect: 'read_only', owner: 'process-read-facet' }],
  list_agent_sessions: [{ branch: 'all', effect: 'read_only', owner: 'agent-read-model' }],
  read_agent_session: [{ branch: 'all', effect: 'read_only', owner: 'agent-read-model' }],
  cancel_card: [{ branch: 'all', effect: 'ordinary_mutation', owner: 'AnalystCardMutationService' }],
  delete_card: [{ branch: 'all', effect: 'ordinary_mutation', owner: 'AnalystCardMutationService' }],
  list_cards: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  get_card: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  get_tree: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  list_card_history: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  get_card_history_entry: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  diff_card: [{ branch: 'all', effect: 'read_only', owner: 'card-read-facet' }],
  read: [{ branch: 'all', effect: 'read_only', owner: 'workspace-read-owner' }],
  write: [{ branch: 'record_brief', effect: 'ordinary_mutation', owner: 'AnalystBriefRecordMutationService' }, { branch: 'project_tmp_system', effect: 'external_workspace_mutation', owner: 'workspace-file-owner' }],
  edit: [{ branch: 'record_brief', effect: 'ordinary_mutation', owner: 'AnalystBriefRecordMutationService' }, { branch: 'project_tmp_system', effect: 'external_workspace_mutation', owner: 'workspace-file-owner' }],
  apply_patch: [{ branch: 'all', effect: 'external_workspace_mutation', owner: 'workspace-file-owner' }],
  glob: [{ branch: 'all', effect: 'read_only', owner: 'workspace-read-owner' }],
  grep: [{ branch: 'all', effect: 'read_only', owner: 'workspace-read-owner' }],
  run_command: [{ branch: 'all', effect: 'external_process_mutation', owner: 'ProcessRunner' }],
  wait_process: [{ branch: 'all', effect: 'read_only', owner: 'ProcessRunner' }],
  kill_process: [{ branch: 'all', effect: 'external_process_mutation', owner: 'ProcessRunner' }],
  websearch: [{ branch: 'all', effect: 'read_only', owner: 'web-read-client' }],
  webfetch: [
    { branch: 'no_save_inline_metadata_error_binary', effect: 'read_only', owner: 'web-read-client' },
    { branch: 'no_save_oversized_text', effect: 'disposable_external_output', owner: 'existing-webfetch-stash-path' },
    { branch: 'save_as_record_brief', effect: 'ordinary_mutation', owner: 'AnalystBriefRecordMutationService' },
    { branch: 'save_as_project_tmp_system', effect: 'external_workspace_mutation', owner: 'workspace-file-owner' },
  ],
  skill: [{ branch: 'all', effect: 'read_only', owner: 'skill-read-provider' }],
  mcp_tool_call: [{ branch: 'all', effect: 'special_owner', owner: 'McpManager.invokeTool' }],
} as const;

import type { McpToolAnnotations } from '../mcp/index.js';
import { TOOL_TO_CARD_ACTION } from '../permissions/index.js';

export type RoleToolPolicyRole = 'planner' | 'executor' | 'reviewer' | 'analyst';
export type RoleToolPolicyAction = 'list' | 'invoke';
export type RoleToolPolicySurface = 'planner-control' | 'agent-runtime' | 'workspace' | 'external-mcp' | 'skill';

export type RoleToolPolicyReasonCode =
  | 'allowed'
  | 'role_not_allowed'
  | 'unknown_role'
  | 'unknown_tool'
  | 'mcp_missing_metadata'
  | 'mcp_destructive_denied'
  | 'mcp_not_read_only'
  | 'surface_not_listed'
  | 'policy_internal_error';

export interface RoleToolPolicyInput {
  role: RoleToolPolicyRole;
  action: RoleToolPolicyAction;
  surface: RoleToolPolicySurface;
  toolName: string;
  serverName?: string;
  mcpAnnotations?: McpToolAnnotations;
  hasMcpDefinition?: boolean;
  knownPlannerTool?: boolean;
  knownRuntimeTool?: boolean;
}

export interface RoleToolPolicyDecision {
  allowed: boolean;
  reasonCode: RoleToolPolicyReasonCode;
  message: string;
  auditTags: string[];
}

const ROLE_TOOL_NAMES: Record<RoleToolPolicyRole, readonly string[]> = {
  planner: [
    'create_card',
    'edit_card',
    'add_note',
    'list_cards',
    'get_card',
    'get_tree',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'list_project_files',
    'read_project_file',
    'write_project_file',
    'wait_for_process',
    'kill_process',
    'start_and_wait',
    'run_project_command',
    'activate_card',
    'cancel_card',
    'delete_card',
    'restart_card',
    'report_goal_done',
    'report_goal_failed',
    'report_goal_blocked',
  ],
  executor: [
    'load_skill',
    'list_project_files',
    'read_project_file',
    'write_project_file',
    'wait_for_process',
    'kill_process',
    'start_and_wait',
    'run_project_command',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'list_notes',
    'get_note',
    'mark_note_handled',
    'mcp_tool_call',
  ],
  reviewer: [
    'load_skill',
    'list_project_files',
    'read_project_file',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'list_notes',
    'get_note',
    'mark_note_handled',
    'mcp_tool_call',
  ],
  analyst: [
    'mark_goal_needs_corrections',
    'list_card_history',
    'get_card_history_entry',
    'diff_card',
    'list_notes',
    'get_note',
    'mark_note_handled',
  ],
};

const VALID_ROLES = new Set<RoleToolPolicyRole>(Object.keys(ROLE_TOOL_NAMES) as RoleToolPolicyRole[]);
const VALID_SURFACES = new Set<RoleToolPolicySurface>(['planner-control', 'agent-runtime', 'workspace', 'external-mcp', 'skill']);
const PLANNER_CONTROL_TOOLS = new Set([...Object.keys(TOOL_TO_CARD_ACTION), 'report_goal_done', 'report_goal_failed', 'report_goal_blocked']);
const SKILL_TOOLS = new Set(['load_skill']);
const WORKSPACE_TOOLS = new Set(['list_project_files', 'read_project_file', 'write_project_file', 'start_and_wait', 'run_project_command', 'wait_for_process', 'kill_process']);
const MCP_WRAPPER_TOOLS = new Set(['mcp_tool_call']);

function decision(input: RoleToolPolicyInput, allowed: boolean, reasonCode: RoleToolPolicyReasonCode, message: string): RoleToolPolicyDecision {
  const auditTags = [
    `role:${input.role}`,
    `surface:${input.surface}`,
    `tool:${input.toolName}`,
    `reason:${reasonCode}`,
  ];
  if (input.serverName) auditTags.push(`server:${input.serverName}`);
  return { allowed, reasonCode, message, auditTags };
}

function allowed(input: RoleToolPolicyInput): RoleToolPolicyDecision {
  return decision(input, true, 'allowed', `Role '${input.role}' is permitted to ${input.action} '${input.toolName}' on ${input.surface}.`);
}

function denied(input: RoleToolPolicyInput, reasonCode: RoleToolPolicyReasonCode, message?: string): RoleToolPolicyDecision {
  return decision(input, false, reasonCode, message ?? `Role '${input.role}' is not permitted to ${input.action} '${input.toolName}' on ${input.surface} (${reasonCode}).`);
}

export class RoleToolPolicy {
  static listToolNamesForRole(role: RoleToolPolicyRole): string[] {
    return [...(ROLE_TOOL_NAMES[role] ?? [])];
  }

  static decide(input: RoleToolPolicyInput): RoleToolPolicyDecision {
    try {
      if (!VALID_ROLES.has(input.role)) return denied(input, 'unknown_role');
      if (!VALID_SURFACES.has(input.surface)) return denied(input, 'surface_not_listed');

      if (input.action === 'list') {
        return ROLE_TOOL_NAMES[input.role].includes(input.toolName) ? allowed(input) : denied(input, 'unknown_tool');
      }

      if (input.surface === 'external-mcp') return this.decideExternalMcp(input);
      if (input.surface === 'planner-control') {
        if (!PLANNER_CONTROL_TOOLS.has(input.toolName) || !input.knownPlannerTool) return denied(input, 'unknown_tool');
        return input.role === 'planner' && ROLE_TOOL_NAMES.planner.includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'agent-runtime') {
        if (!input.knownRuntimeTool) return denied(input, 'unknown_tool');
        return ROLE_TOOL_NAMES[input.role].includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'workspace') {
        if (!WORKSPACE_TOOLS.has(input.toolName)) return denied(input, 'unknown_tool');
        return ROLE_TOOL_NAMES[input.role].includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'skill') {
        if (!SKILL_TOOLS.has(input.toolName)) return denied(input, 'unknown_tool');
        return ROLE_TOOL_NAMES[input.role].includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      return denied(input, 'surface_not_listed');
    } catch {
      return denied(input, 'policy_internal_error');
    }
  }

  private static decideExternalMcp(input: RoleToolPolicyInput): RoleToolPolicyDecision {
    if (!MCP_WRAPPER_TOOLS.has(input.toolName) && input.toolName !== '') return denied(input, 'unknown_tool');
    if (!ROLE_TOOL_NAMES[input.role].includes('mcp_tool_call')) return denied(input, 'role_not_allowed');
    if (input.role === 'analyst') return denied(input, 'role_not_allowed');
    if (input.role === 'executor') return allowed(input);
    if (!input.hasMcpDefinition || !input.mcpAnnotations) return denied(input, 'mcp_missing_metadata');
    if (input.mcpAnnotations.destructiveHint === true) return denied(input, 'mcp_destructive_denied');
    if (input.mcpAnnotations.readOnlyHint !== true) return denied(input, 'mcp_not_read_only');
    return allowed(input);
  }
}

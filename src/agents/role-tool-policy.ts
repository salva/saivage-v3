import type { McpToolAnnotations } from '../mcp/protocol-api.js';
import type { OperationalAgentRole } from '../schemas/index.js';
import { MCP_WRAPPER_TOOL_NAMES, PLANNER_CONTROL_TOOL_NAMES, ROLE_TOOL_NAMES, SKILL_TOOL_NAMES, WORKSPACE_TOOL_NAMES } from './agent-tool-catalog.js';

export type RoleToolPolicyRole = OperationalAgentRole;
export type RoleToolPolicyAction = 'list' | 'invoke';
export type RoleToolPolicySurface = 'planner-control' | 'agent-runtime' | 'workspace' | 'external-mcp' | 'skill' | 'contract-terminal';

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
  contractTerminals?: readonly string[];
}

export interface RoleToolPolicyDecision {
  allowed: boolean;
  reasonCode: RoleToolPolicyReasonCode;
  message: string;
  auditTags: string[];
}

const VALID_ROLES = new Set<RoleToolPolicyRole>(Object.keys(ROLE_TOOL_NAMES) as RoleToolPolicyRole[]);
const VALID_SURFACES = new Set<RoleToolPolicySurface>(['planner-control', 'agent-runtime', 'workspace', 'external-mcp', 'skill', 'contract-terminal']);

function roleToolNames(role: RoleToolPolicyRole): readonly string[] { return ROLE_TOOL_NAMES[role] ?? []; }

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
    return [...roleToolNames(role)];
  }

  static assertAnalystSurfaceTool(toolName: string, surface: 'web' | 'telegram' | string): RoleToolPolicyDecision {
    const input: RoleToolPolicyInput = { role: 'analyst', action: 'invoke', surface: 'agent-runtime', toolName, knownRuntimeTool: roleToolNames('analyst').includes(toolName) };
    return roleToolNames('analyst').includes(toolName) ? allowed(input) : denied(input, 'unknown_tool');
  }

  static decide(input: RoleToolPolicyInput): RoleToolPolicyDecision {
    try {
      if (!VALID_ROLES.has(input.role)) return denied(input, 'unknown_role');
      if (!VALID_SURFACES.has(input.surface)) return denied(input, 'surface_not_listed');

      if (input.action === 'list') {
        return roleToolNames(input.role).includes(input.toolName) ? allowed(input) : denied(input, 'unknown_tool');
      }

      if (input.surface === 'external-mcp') return this.decideExternalMcp(input);
      if (input.surface === 'planner-control') {
        if (!PLANNER_CONTROL_TOOL_NAMES.has(input.toolName) || !input.knownPlannerTool) return denied(input, 'unknown_tool');
        return input.role === 'planner' && roleToolNames('planner').includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'agent-runtime') {
        if (!input.knownRuntimeTool) return denied(input, 'unknown_tool');
        return roleToolNames(input.role).includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'workspace') {
        if (!WORKSPACE_TOOL_NAMES.has(input.toolName)) return denied(input, 'unknown_tool');
        return roleToolNames(input.role).includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'skill') {
        if (!SKILL_TOOL_NAMES.has(input.toolName)) return denied(input, 'unknown_tool');
        return roleToolNames(input.role).includes(input.toolName) ? allowed(input) : denied(input, 'role_not_allowed');
      }
      if (input.surface === 'contract-terminal') {
        const terminals = input.contractTerminals ?? [];
        if (terminals.length === 0) return denied(input, 'unknown_tool');
        return terminals.includes(input.toolName) ? allowed(input) : denied(input, 'unknown_tool');
      }
      return denied(input, 'surface_not_listed');
    } catch {
      return denied(input, 'policy_internal_error');
    }
  }

  private static decideExternalMcp(input: RoleToolPolicyInput): RoleToolPolicyDecision {
    if (!MCP_WRAPPER_TOOL_NAMES.has(input.toolName) && input.toolName !== '') return denied(input, 'unknown_tool');
    if (!roleToolNames(input.role).includes('mcp_tool_call')) return denied(input, 'role_not_allowed');
    if (input.role === 'analyst') return denied(input, 'role_not_allowed');
    if (input.role === 'executor') return allowed(input);
    if (!input.hasMcpDefinition || !input.mcpAnnotations) return denied(input, 'mcp_missing_metadata');
    if (input.mcpAnnotations.destructiveHint === true) return denied(input, 'mcp_destructive_denied');
    if (input.mcpAnnotations.readOnlyHint !== true) return denied(input, 'mcp_not_read_only');
    return allowed(input);
  }
}

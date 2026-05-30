import { describe, expect, it } from '@jest/globals';

import { RoleToolPolicy } from '../../src/agents/role-tool-policy.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-llm-resolver.js';
import { TOOL_TO_CARD_ACTION } from '../../src/permissions/index.js';
import type { RoleToolPolicyRole } from '../../src/agents/role-tool-policy.js';

const roles: RoleToolPolicyRole[] = ['planner', 'executor', 'reviewer', 'analyst'];

describe('RoleToolPolicy', () => {
  it('lists current role tool names in compatibility order', () => {
    expect(RoleToolPolicy.listToolNamesForRole('planner')).toEqual([
      'create_card',
      'edit_card',
      'move_card',
      'reorder_child',
      'queue_notification',
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
      'emit_planner_result',
    ]);
    expect(RoleToolPolicy.listToolNamesForRole('executor')).toContain('mcp_tool_call');
    expect(RoleToolPolicy.listToolNamesForRole('reviewer')).toContain('mcp_tool_call');
    expect(RoleToolPolicy.listToolNamesForRole('analyst')).not.toContain('mcp_tool_call');
  });

  it('uses stable safe denial reason codes for unknown tools and surfaces', () => {
    const unknownTool = RoleToolPolicy.decide({ role: 'executor', action: 'invoke', surface: 'workspace', toolName: 'nope' });
    expect(unknownTool.allowed).toBe(false);
    expect(unknownTool.reasonCode).toBe('unknown_tool');
    expect(unknownTool.message).toContain('nope');
    expect(unknownTool.message).not.toContain('synthetic-secret');

    const unknownSurface = RoleToolPolicy.decide({ role: 'executor', action: 'invoke', surface: 'bogus' as never, toolName: 'read_project_file' });
    expect(unknownSurface.allowed).toBe(false);
    expect(unknownSurface.reasonCode).toBe('surface_not_listed');
  });

  it('fails external MCP closed for analysts and missing or unsafe metadata', () => {
    const analyst = RoleToolPolicy.decide({ role: 'analyst', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: true, mcpAnnotations: { readOnlyHint: true, destructiveHint: false } });
    expect(analyst.allowed).toBe(false);
    expect(analyst.reasonCode).toBe('role_not_allowed');

    const missingMetadata = RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: false });
    expect(missingMetadata.allowed).toBe(false);
    expect(missingMetadata.reasonCode).toBe('mcp_missing_metadata');

    const destructive = RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: true, mcpAnnotations: { readOnlyHint: true, destructiveHint: true } });
    expect(destructive.allowed).toBe(false);
    expect(destructive.reasonCode).toBe('mcp_destructive_denied');

    const notReadOnly = RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: true, mcpAnnotations: { destructiveHint: false } });
    expect(notReadOnly.allowed).toBe(false);
    expect(notReadOnly.reasonCode).toBe('mcp_not_read_only');
  });

  it('allows existing authorized-role regressions without expanding planner MCP', () => {
    expect(RoleToolPolicy.decide({ role: 'executor', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: false }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: true, mcpAnnotations: { readOnlyHint: true, destructiveHint: false } }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'planner', action: 'invoke', surface: 'external-mcp', toolName: 'mcp_tool_call', serverName: 'svc', hasMcpDefinition: true, mcpAnnotations: { readOnlyHint: true, destructiveHint: false } }).allowed).toBe(false);
    expect(RoleToolPolicy.decide({ role: 'planner', action: 'invoke', surface: 'planner-control', toolName: 'activate_card', knownPlannerTool: true }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'read_project_file' }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'write_project_file' }).allowed).toBe(false);
  });

  it('derives planner-control lifecycle tool names from the permission matrix mapping', () => {
    expect(Object.keys(TOOL_TO_CARD_ACTION)).toEqual(['activate_card', 'cancel_card', 'delete_card', 'restart_card']);
    expect(RoleToolPolicy.decide({ role: 'planner', action: 'invoke', surface: 'planner-control', toolName: 'restart_card', knownPlannerTool: true }).allowed).toBe(true);
  });



  it('keeps analyst policy exactly aligned with the analyst tool registry and denies Telegram shell', () => {
    expect(RoleToolPolicy.listToolNamesForRole('analyst').sort()).toEqual(Object.keys(TOOL_REGISTRY).sort());
    const telegramShell = RoleToolPolicy.assertAnalystSurfaceTool('run_shell_command', 'telegram');
    expect(telegramShell.allowed).toBe(false);
    expect(telegramShell.reasonCode).toBe('role_not_allowed');
  });

  it('keeps list decisions consistent with role tool lists', () => {
    for (const role of roles) {
      for (const toolName of RoleToolPolicy.listToolNamesForRole(role)) {
        expect(RoleToolPolicy.decide({ role, action: 'list', surface: 'agent-runtime', toolName }).allowed).toBe(true);
      }
      expect(RoleToolPolicy.decide({ role, action: 'list', surface: 'agent-runtime', toolName: 'not_in_list' }).reasonCode).toBe('unknown_tool');
    }
  });
});

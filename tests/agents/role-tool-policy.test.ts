import { describe, expect, it } from '@jest/globals';

import { RoleToolPolicy } from '../../src/agents/role-tool-policy.js';
import { ANALYST_TOOL_NAMES } from '../../src/tools/definitions/index.js';
import type { RoleToolPolicyRole } from '../../src/agents/role-tool-policy.js';

const roles: RoleToolPolicyRole[] = ['planner', 'executor', 'reviewer', 'analyst'];

describe('RoleToolPolicy', () => {
  it('lists current role tool names in compatibility order', () => {
    expect(RoleToolPolicy.listToolNamesForRole('planner')).toEqual([
      'create_card',
      'edit_card',
      'reorder_child',
      'queue_notification',
      'list_cards',
      'get_card',
      'get_tree',
      'list_card_history',
      'get_card_history_entry',
      'diff_card',
      'read',
      'write',
      'glob',
      'grep',
      'edit',
      'websearch',
      'webfetch',
      'activate_card',
      'cancel_card',
      'delete_card',
      'restart_card',
      'report_goal_done',
      'report_goal_failed',
      'report_goal_blocked',
    ]);
    expect(RoleToolPolicy.listToolNamesForRole('executor')).toContain('mcp_tool_call');
    expect(RoleToolPolicy.listToolNamesForRole('reviewer')).toContain('mcp_tool_call');
    expect(RoleToolPolicy.listToolNamesForRole('analyst')).not.toContain('mcp_tool_call');
    expect(RoleToolPolicy.listToolNamesForRole('analyst')).not.toContain('move_card');
    expect(RoleToolPolicy.listToolNamesForRole('planner')).not.toContain('move_card');
  });

  it('uses stable safe denial reason codes for unknown tools and surfaces', () => {
    const unknownTool = RoleToolPolicy.decide({ role: 'executor', action: 'invoke', surface: 'workspace', toolName: 'nope' });
    expect(unknownTool.allowed).toBe(false);
    expect(unknownTool.reasonCode).toBe('unknown_tool');
    expect(unknownTool.message).toContain('nope');
    expect(unknownTool.message).not.toContain('synthetic-secret');

    const unknownSurface = RoleToolPolicy.decide({ role: 'executor', action: 'invoke', surface: 'bogus' as never, toolName: 'read' });
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
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'read' }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'write' }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'edit' }).allowed).toBe(true);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'apply_patch' }).allowed).toBe(false);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'run_command' }).allowed).toBe(false);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'wait_process' }).allowed).toBe(false);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'kill_process' }).allowed).toBe(false);
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'run_project_command' }).reasonCode).toBe('unknown_tool');
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'start_and_wait' }).reasonCode).toBe('unknown_tool');
    expect(RoleToolPolicy.decide({ role: 'reviewer', action: 'invoke', surface: 'workspace', toolName: 'wait_for_process' }).reasonCode).toBe('unknown_tool');
  });

  it('allows known planner-control lifecycle tools at the planner-control boundary', () => {
    expect(RoleToolPolicy.decide({ role: 'planner', action: 'invoke', surface: 'planner-control', toolName: 'restart_card', knownPlannerTool: true }).allowed).toBe(true);
  });



  it('keeps analyst policy exactly aligned with analyst tool definitions and rejects removed shell alias', () => {
    expect(RoleToolPolicy.listToolNamesForRole('analyst').sort()).toEqual([...ANALYST_TOOL_NAMES].sort());
    const telegramShell = RoleToolPolicy.assertAnalystSurfaceTool('run_shell_command', 'telegram');
    expect(telegramShell.allowed).toBe(false);
    expect(telegramShell.reasonCode).toBe('unknown_tool');
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

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { EventQueryService } from '../../src/application/event-query-service.js';
import { CardService } from '../../src/cards/card-service.js';
import type { McpToolInvocationPort } from '../../src/mcp/mcp-manager.js';
import { createMcpToolInvocationInstallation, McpToolInvocationNotInstalledError } from '../../src/mcp/tool-invocation-installation.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { invokeToolForLlm, surfaceToolDefinitions } from '../../src/tools/invocation.js';
import { buildRoleSurface, type RoleSurfaceContext } from '../../src/tools/role-invocation-surfaces.js';
import { TERMINAL_RESULT_TOOL_NAME } from '../../src/contracts/result-envelope.js';
import { KNOWN_TOOL_INVOCATION_NAMES } from '../../src/tools/tool-invocation-outbound.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { testLlmToolInvocationContext, unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { createTestDirectProcessScope, createTestProcessRunner } from '../helpers/test-process-runner.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

const plannerTools = ['create_card', 'edit_card', 'cancel_card', 'activate_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree', 'read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch'];
const reviewerTools = ['read', 'write', 'edit', 'glob', 'grep', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'];
const executorTools = ['read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'list_card_history', 'get_card_history_entry', 'diff_card', 'websearch', 'webfetch', 'skill', 'mcp_tool_call'];
const analystTools = [
  'create_card', 'reorder_child', 'queue_notification', 'get_status', 'start_project', 'pause_runtime', 'resume_runtime', 'stop_project', 'navigate_workspace', 'navigate_back', 'show_config', 'reconfigure', 'mcp_reconcile', 'read_runtime_events', 'read_runtime_errors', 'read_control_actions', 'list_processes_tool', 'list_agent_sessions', 'read_agent_session', 'cancel_card', 'delete_card',
  'list_cards', 'get_card', 'get_tree', 'list_card_history', 'get_card_history_entry', 'diff_card', 'read', 'write', 'edit', 'glob', 'grep', 'apply_patch', 'run_command', 'wait_process', 'kill_process', 'websearch', 'webfetch', 'skill', 'mcp_tool_call',
];

describe('role invocation surfaces', () => {
  const cases: Array<[RoleSurfaceContext['role'], readonly string[], readonly string[]]> = [
    ['planner', ['planner-control', 'card-inspection', 'workspace', 'card-history', 'web'], plannerTools],
    ['reviewer', ['workspace', 'card-history', 'web', 'skill', 'mcp'], reviewerTools],
    ['executor', ['workspace', 'patch', 'process', 'card-history', 'web', 'skill', 'mcp'], executorTools],
    ['analyst', ['analyst', 'card-inspection', 'card-history', 'workspace', 'patch', 'process', 'web', 'skill', 'mcp'], analystTools],
  ];
  it.each(cases)('preserves exact %s provider, executable, and operational wire order', (role, providers, tools) => {
    const surface = buildRoleSurface(fixture(role));
    expect(surface.providers.map((provider) => provider.providerName)).toEqual(providers);
    expect([...surface.tools.keys()]).toEqual(tools);
    expect(surfaceToolDefinitions(surface).map((tool) => tool.function.name)).toEqual(tools);
    expect(tools.filter((name) => name === 'mcp_tool_call')).toHaveLength(role === 'planner' ? 0 : 1);
  });

  it('keeps the outbound invocation switch equal to the source-derived role-plus-terminal inventory', () => {
    const analyst = fixture('analyst');
    if (analyst.role !== 'analyst') throw new Error('Expected Analyst fixture.');
    const roleContexts: RoleSurfaceContext[] = [
      fixture('planner'), fixture('reviewer'), fixture('executor'),
      { ...analyst, toolContext: { ...analyst.toolContext, restartServerAvailable: true } },
    ];
    expect(buildRoleSurface(roleContexts[3]!).tools.size).toBe(41);
    const sourceNames = new Set(roleContexts.flatMap((context) => [...buildRoleSurface(context).tools.keys()]));
    sourceNames.add(TERMINAL_RESULT_TOOL_NAME);
    expect([...sourceNames].sort()).toEqual([...KNOWN_TOOL_INVOCATION_NAMES].sort());
    expect(sourceNames.size).toBe(44);
  });

  it.each(['planner', 'analyst'] as const)('%s create_card exposes no status property', (role) => {
    const create = surfaceToolDefinitions(buildRoleSurface(fixture(role))).find((tool) => tool.function.name === 'create_card');
    expect(create).toBeDefined();
    expect(create?.function.parameters).toMatchObject({ type: 'object', additionalProperties: false });
    expect(create?.function.parameters).not.toHaveProperty('properties.status');
  });

  it.each(['planner', 'analyst'] as const)('%s create_card rejects a legacy status key at the composed boundary', async (role) => {
    const context = fixture(role);
    const surface = buildRoleSurface(context);
    for (const status of ['backlog', 'running']) {
      await expect(invokeToolForLlm(surface, 'create_card', { type: 'code', title: 'strict child', brief: 'strict brief', status }, testLlmToolInvocationContext({ toolName: 'create_card' })))
        .resolves.toMatchObject({ success: false });
    }
    const store = context.role === 'analyst' ? context.toolContext.store : context.store;
    expect(store.listChildren('project')).toEqual([]);
  });

  it('resolves the one-shot MCP authority at call time through an already-built Executor surface', async () => {
    const installation = createMcpToolInvocationInstallation();
    const context = fixture('executor', installation.port);
    const surface = buildRoleSurface(context);
    const args = { serverName: 'test-server', toolName: 'test-tool', args: { value: 7 } };

    await expect(invokeToolForLlm(surface, 'mcp_tool_call', args, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).rejects.toBeInstanceOf(McpToolInvocationNotInstalledError);

    const invokeTool = jest.fn<McpToolInvocationPort['invokeTool']>(async () => ({ accepted: true }));
    installation.installer.install({ getServerTools: () => [], findToolCapability: () => null, invokeTool });
    await expect(invokeToolForLlm(surface, 'mcp_tool_call', args, testLlmToolInvocationContext({ toolName: 'mcp_tool_call' }))).resolves.toEqual({ success: true, data: { accepted: true } });
    expect(invokeTool).toHaveBeenCalledWith('test-server', 'test-tool', { value: 7 }, undefined);
  });
});

function fixture(role: RoleSurfaceContext['role'], mcpToolInvocation: McpToolInvocationPort = unusedMcpToolInvocation): RoleSurfaceContext {
  const projectRoot = mkdtempSync(join(tmpdir(), `saivage-${role}-surface-`));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const store = new CardService(projectRoot);
  const processes = createTestProcessRunner(projectRoot);
  const processRunner = processes.processRunner;
  if (role === 'planner') return { role, projectRoot, cardId: 'project', sessionId: 'planner:project', store, parentControl: { activateChild: async () => { throw new Error('unused'); }, cancelChild: async ({ childCardId }) => ({ card_id: childCardId, status: 'cancelled', cancelled_card_ids: [childCardId] }) }, notifyCard: () => ({ ok: true, notificationId: 'test-notification' }) };
  if (role === 'reviewer') return { role, projectRoot, cardId: 'project', store, mcpToolInvocation };
  if (role === 'executor') return { role, projectRoot, cardId: 'project', ownerId: 'activation:test:node:0', store, processRunner, processScope: createTestDirectProcessScope(processes, 'runtime_card'), mcpToolInvocation };
  const toolContext: ToolContext = {
    projectRoot,
    configAuthority: testConfigAuthority(projectRoot),
    interventionReadiness: new RuntimeInterventionBinding(),
    processRunner,
    processScope: createTestDirectProcessScope(processes, 'operator_session'),
    store,
    sessionId: 'analyst:global',
    mcpToolInvocation,
    restartServerAvailable: false,
    actor: 'analyst',
    surface: 'web-chat',
    eventQueries: new EventQueryService(projectRoot),
    captureExecutingLlmSnapshots: () => [],
  };
  return { role, toolContext };
}

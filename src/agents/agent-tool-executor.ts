import type { ContentSupervisor } from '../workspace/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import type { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import type { SkillsEngine } from './skills-engine.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { RoleToolPolicy } from './role-tool-policy.js';
import { AgentToolCatalog } from './agent-tool-catalog.js';
import type { AgentRole } from './agent-adapter.js';
import { McpAdapter, PlannerControlAdapter, RuntimeToolAdapter, SkillAdapter, ToolDispatcher, type ToolDispatchResult, WorkspaceAdapter } from './tool-dispatcher.js';

export type ParsedToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type AgentToolMessage = ToolDispatchResult;

export interface AgentToolExecutorConfig {
  projectRoot: string;
  toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>;
  plannerControlExecutor: PlannerControlExecutor;
  getMcpManager: () => McpToolInvocationPort | undefined;
  getSkillsEngine: () => SkillsEngine | undefined;
  getContentSupervisor: () => ContentSupervisor | undefined;
}

export class AgentToolExecutor {
  private readonly projectRoot: string;
  private readonly toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>;
  private readonly plannerControlExecutor: PlannerControlExecutor;
  private readonly getMcpManagerProvider: () => McpToolInvocationPort | undefined;
  private readonly getSkillsEngineProvider: () => SkillsEngine | undefined;
  private readonly getContentSupervisorProvider: () => ContentSupervisor | undefined;
  private readonly dispatcher: ToolDispatcher;

  constructor(config: AgentToolExecutorConfig) {
    this.projectRoot = config.projectRoot;
    this.toolRuntime = config.toolRuntime;
    this.plannerControlExecutor = config.plannerControlExecutor;
    this.getMcpManagerProvider = config.getMcpManager;
    this.getSkillsEngineProvider = config.getSkillsEngine;
    this.getContentSupervisorProvider = config.getContentSupervisor;
    this.dispatcher = new ToolDispatcher([
      new PlannerControlAdapter(this.plannerControlExecutor),
      new RuntimeToolAdapter(this.projectRoot, this.toolRuntime),
      new McpAdapter(this.getMcpManagerProvider, this.getContentSupervisorProvider),
      new SkillAdapter(this.getSkillsEngineProvider),
      new WorkspaceAdapter(this.projectRoot),
    ]);
  }

  getToolNamesForRole(role: AgentRole): string[] { return RoleToolPolicy.listToolNamesForRole(role); }

  buildToolsForRole(role: AgentRole) {
    const runtimeSchema = this.toolRuntime.schema().filter((tool) => tool.roles.includes(role));
    return this.getToolNamesForRole(role)
      .map((name) => runtimeSchema.find((tool) => tool.function.name === name) ?? AgentToolCatalog.definitionFor(name))
      .filter((tool): tool is NonNullable<ReturnType<typeof AgentToolCatalog.definitionFor>> => Boolean(tool));
  }

  async callMcpTool(role: AgentRole, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await this.dispatcher.dispatch({ id: `direct-mcp:${serverName}/${toolName}`, name: 'mcp_tool_call', arguments: JSON.stringify({ serverName, toolName, args }) }, {
      role,
      sessionId: `direct-mcp:${serverName}/${toolName}`,
      knownRuntimeTool: (name) => this.toolRuntime.has(name),
      knownPlannerTool: (name) => AgentToolCatalog.isPlannerControlTool(name),
    });
    if (result.kind === 'tool_error') throw new Error(result.content);
    try { return JSON.parse(result.content) as unknown; } catch { return result.content; }
  }

  async processToolCall(tc: ParsedToolCall, role: AgentRole, sessionId: string, invocation?: { goalId?: string; cardId?: string }): Promise<AgentToolMessage> {
    return this.dispatcher.dispatch({ id: tc.id, name: tc.function.name, arguments: tc.function.arguments }, {
      role,
      sessionId,
      goalId: invocation?.goalId,
      cardId: invocation?.cardId,
      knownRuntimeTool: (name) => this.toolRuntime.has(name),
      knownPlannerTool: (name) => AgentToolCatalog.isPlannerControlTool(name),
    });
  }
}

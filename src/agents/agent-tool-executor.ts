import type { ContentSupervisor } from '../workspace/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { McpInvokeError, type McpToolDefinition } from '../mcp/protocol-api.js';
import type { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import type { ToolResult } from '../tools/analyst-tool-types.js';
import { loadSkill, LoadSkillError } from './skill-tools.js';
import type { SkillsEngine } from './skills-engine.js';
import { processWorkspaceToolCall } from './workspace-tools.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { RoleToolPolicy, type RoleToolPolicyDecision, type RoleToolPolicySurface } from './role-tool-policy.js';
import { AgentToolCatalog } from './agent-tool-catalog.js';
import type { AgentRole } from './agent-adapter.js';

export type ParsedToolCall = { id: string; type: string; function: { name: string; arguments: string } };
export type AgentToolMessage = { role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string; tool_call_id: string };

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

  constructor(config: AgentToolExecutorConfig) {
    this.projectRoot = config.projectRoot;
    this.toolRuntime = config.toolRuntime;
    this.plannerControlExecutor = config.plannerControlExecutor;
    this.getMcpManagerProvider = config.getMcpManager;
    this.getSkillsEngineProvider = config.getSkillsEngine;
    this.getContentSupervisorProvider = config.getContentSupervisor;
  }

  getToolNamesForRole(role: AgentRole): string[] { return RoleToolPolicy.listToolNamesForRole(role); }

  buildToolsForRole(role: AgentRole) {
    const runtimeSchema = this.toolRuntime.schema().filter((tool) => tool.roles.includes(role));
    return this.getToolNamesForRole(role)
      .map((name) => runtimeSchema.find((tool) => tool.function.name === name) ?? AgentToolCatalog.definitionFor(name))
      .filter((tool): tool is NonNullable<ReturnType<typeof AgentToolCatalog.definitionFor>> => Boolean(tool));
  }

  private getMcpToolDefinition(serverName: string, toolName: string): McpToolDefinition | null {
    const mcpManager = this.getMcpManagerProvider();
    if (!mcpManager) return null;
    const tools = mcpManager.getServerTools(serverName);
    return tools?.find((tool) => tool.name === toolName) ?? null;
  }

  private policyDeniedToolMessage(decision: RoleToolPolicyDecision, tool: string, toolCallId: string, prefix?: string): AgentToolMessage {
    const content = prefix ? `${prefix}: ${decision.message}` : JSON.stringify({ success: false, error: decision.message, reasonCode: decision.reasonCode });
    return { role: 'tool', kind: 'tool_error', content, tool, tool_call_id: toolCallId };
  }

  private decideToolInvocation(role: AgentRole, surface: RoleToolPolicySurface, toolName: string, options: { serverName?: string; definition?: McpToolDefinition | null; knownPlannerTool?: boolean; knownRuntimeTool?: boolean } = {}): RoleToolPolicyDecision {
    return RoleToolPolicy.decide({
      role,
      action: 'invoke',
      surface,
      toolName,
      serverName: options.serverName,
      hasMcpDefinition: options.definition !== undefined ? Boolean(options.definition) : undefined,
      mcpAnnotations: options.definition?.annotations,
      knownPlannerTool: options.knownPlannerTool,
      knownRuntimeTool: options.knownRuntimeTool,
    });
  }

  async callMcpTool(role: AgentRole, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    const mcpManager = this.getMcpManagerProvider();
    if (!mcpManager) throw new Error('MCP manager not configured. Call setMcpManager() first.');
    const toolDefinition = this.getMcpToolDefinition(serverName, toolName);
    const policyDecision = this.decideToolInvocation(role, 'external-mcp', 'mcp_tool_call', { serverName, definition: toolDefinition });
    if (!policyDecision.allowed) throw new Error(policyDecision.message);
    let result: unknown;
    try { result = await mcpManager.invokeTool(serverName, toolName, args); } catch (err) { if (err instanceof McpInvokeError) throw err; throw new Error(`MCP tool invocation failed for '${toolName}' on '${serverName}': ${err instanceof Error ? err.message : String(err)}`); }
    const contentSupervisor = this.getContentSupervisorProvider();
    if (contentSupervisor && !contentSupervisor.isScreeningDisabled()) {
      const screenResult = await contentSupervisor.screenContent({ sourceKind: 'tool', sourceRef: `mcp:${serverName}/${toolName}`, content: JSON.stringify(result) });
      if (screenResult.status === 'blocked') throw new Error(`MCP tool response blocked by content supervisor: ${screenResult.summary}`);
    }
    return result;
  }

  async processToolCall(tc: ParsedToolCall, role: AgentRole, sessionId: string, invocation?: { goalId?: string; cardId?: string }): Promise<AgentToolMessage> {
    if (role === 'planner' && !AgentToolCatalog.isPlannerTool(tc.function.name)) {
      return { role: 'tool', kind: 'tool_error', content: `Unknown planner tool '${tc.function.name}'.`, tool: tc.function.name, tool_call_id: tc.id };
    }
    if (!(role === 'planner' && AgentToolCatalog.isPlannerControlTool(tc.function.name)) && this.toolRuntime.has(tc.function.name)) {
      let input: unknown = {};
      try { input = JSON.parse(tc.function.arguments); } catch {
        return { role: 'tool', kind: 'tool_error', content: JSON.stringify({ success: false, error: `Invalid JSON arguments for '${tc.function.name}'.` }), tool: tc.function.name, tool_call_id: tc.id };
      }
      const result = await this.toolRuntime.invoke({ name: tc.function.name, input, role, correlationId: tc.id, projectRoot: this.projectRoot, sessionId });
      if (!result.ok) {
        return { role: 'tool', kind: 'tool_error', content: JSON.stringify({ success: false, error: result.error.message, tool_error: result.error }), tool: tc.function.name, tool_call_id: tc.id };
      }
      const output = result.output as ToolResult;
      return { role: 'tool', kind: output.success ? 'tool_result' : 'tool_error', content: JSON.stringify(output), tool: tc.function.name, tool_call_id: tc.id };
    }
    if (role === 'planner' && AgentToolCatalog.isPlannerControlTool(tc.function.name)) {
      const policyDecision = this.decideToolInvocation(role, 'planner-control', tc.function.name, { knownPlannerTool: true });
      if (!policyDecision.allowed) return this.policyDeniedToolMessage(policyDecision, tc.function.name, tc.id);
      return this.plannerControlExecutor.execute({
        sessionId,
        toolCallId: tc.id,
        toolName: tc.function.name,
        argumentsJson: tc.function.arguments,
        parentCardId: invocation?.cardId ?? invocation?.goalId,
      });
    }
    if (tc.function.name === 'mcp_tool_call') {
      let args: { serverName?: string; toolName?: string; args?: Record<string, unknown> } = {};
      try { args = JSON.parse(tc.function.arguments); } catch { void 0; }
      const serverName = args.serverName ?? '';
      const toolName = args.toolName ?? '';
      const toolArgs = args.args ?? {};
      if (!serverName || !toolName) return { role: 'tool', kind: 'tool_error', content: 'mcp_tool_call requires both "serverName" and "toolName" parameters.', tool: 'mcp_tool_call', tool_call_id: tc.id };
      const toolDefinition = this.getMcpToolDefinition(serverName, toolName);
      const policyDecision = this.decideToolInvocation(role, 'external-mcp', 'mcp_tool_call', { serverName, definition: toolDefinition });
      if (!policyDecision.allowed) return this.policyDeniedToolMessage(policyDecision, `mcp_tool_call:${serverName}/${toolName}`, tc.id, 'MCP tool call failed');
      try { const result = await this.callMcpTool(role, serverName, toolName, toolArgs); return { role: 'tool', kind: 'tool_result', content: typeof result === 'string' ? result : JSON.stringify(result), tool: `mcp_tool_call:${serverName}/${toolName}`, tool_call_id: tc.id }; } catch (err) { const errorMsg = err instanceof Error ? err.message : String(err); return { role: 'tool', kind: 'tool_error', content: `MCP tool call failed: ${errorMsg}`, tool: `mcp_tool_call:${serverName}/${toolName}`, tool_call_id: tc.id }; }
    }
    if (tc.function.name === 'load_skill') {
      let args: { name?: string } = {};
      try { args = JSON.parse(tc.function.arguments); } catch { void 0; }
      const skillName = args.name ?? '';
      const policyDecision = this.decideToolInvocation(role, 'skill', 'load_skill');
      if (!policyDecision.allowed) return this.policyDeniedToolMessage(policyDecision, `load_skill:${skillName}`, tc.id, 'load_skill failed');
      try { const skillsEngine = this.getSkillsEngineProvider(); if (!skillsEngine) throw new Error('SkillsEngine not configured. Call setSkillsEngine() first.'); const result = await loadSkill(skillName, role, skillsEngine); return { role: 'tool', kind: 'tool_result', content: result.skill_content, tool: `load_skill:${skillName}`, tool_call_id: tc.id }; } catch (err) { const errorMsg = err instanceof LoadSkillError ? err.message : `Error loading skill '${skillName}': ${err instanceof Error ? err.message : String(err)}`; return { role: 'tool', kind: 'tool_error', content: errorMsg, tool: `load_skill:${skillName}`, tool_call_id: tc.id }; }
    }
    if (AgentToolCatalog.isWorkspaceTool(tc.function.name)) {
      const policyDecision = this.decideToolInvocation(role, 'workspace', tc.function.name);
      if (!policyDecision.allowed) return this.policyDeniedToolMessage(policyDecision, tc.function.name, tc.id, `${tc.function.name} failed`);
      try { const result = await processWorkspaceToolCall(tc.function.name, tc.function.arguments, { projectRoot: this.projectRoot, sessionId, goalId: invocation?.goalId, cardId: invocation?.cardId }); return { role: 'tool', kind: 'tool_result', content: typeof result === 'string' ? result : JSON.stringify(result), tool: tc.function.name, tool_call_id: tc.id }; } catch (err) { return { role: 'tool', kind: 'tool_error', content: `${tc.function.name} failed: ${err instanceof Error ? err.message : String(err)}`, tool: tc.function.name, tool_call_id: tc.id }; }
    }
    return { role: 'tool', kind: 'tool_error', content: `Unknown tool '${tc.function.name}'.`, tool: tc.function.name, tool_call_id: tc.id };
  }
}

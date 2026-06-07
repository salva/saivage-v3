import type { ContentSupervisor } from '../workspace/index.js';
import type { McpToolInvocationPort } from '../mcp/manager-api.js';
import { McpInvokeError } from '../mcp/protocol-api.js';
import type { ControlActionSurface } from '../schemas/index.js';
import type { ToolRuntime, AGENT_TOOL_DEFINITIONS } from '../tools/index.js';
import type { ToolResult, ToolContext } from '../tools/analyst-tool-types.js';
import { toolFailure, toolFailureFromError } from '../tools/analyst-tool-helpers.js';
import { ANALYST_UNKNOWN_CAPABILITY_TEMPLATE } from './analyst-tool-runner.js';
import { loadSkill, LoadSkillError } from './skill-tools.js';
import type { SkillsEngine } from './skills-engine.js';
import { processWorkspaceToolCall } from './workspace-tools.js';
import { PlannerControlExecutor } from './planner-control-executor.js';
import { RoleToolPolicy, type RoleToolPolicyDecision, type RoleToolPolicySurface } from './role-tool-policy.js';
import type { AgentRole } from './agent-adapter.js';
import { TOOL_REGISTRY } from './analyst-prompt.js';

export interface ToolCallEnvelope {
  id: string;
  name: string;
  arguments: string;
}

export interface AdapterResult {
  success: boolean;
  data?: unknown;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolDispatchResult {
  role: 'tool';
  kind: 'tool_result' | 'tool_error';
  content: string;
  tool: string;
  tool_call_id: string;
  adapterResult?: AdapterResult;
}

export interface ToolDispatchContext {
  role: AgentRole;
  sessionId: string;
  goalId?: string;
  cardId?: string;
  surface?: RoleToolPolicySurface;
  analystSurface?: ControlActionSurface;
  knownRuntimeTool?: (name: string) => boolean;
  knownPlannerTool?: (name: string) => boolean;
  contractTerminals?: readonly string[];
  toolContext?: ToolContext;
}

export interface ToolDispatchPolicy {
  maxResultLength: number;
  categoryMaxResultLength?: Record<string, number>;
}

export interface ToolDispatchPersistence {
  persistToolResult(sessionId: string, msg: ToolDispatchResult): void;
}

export interface ToolDispatchAdapter {
  category: string;
  handles(toolName: string): boolean;
  policyInput?(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Partial<Parameters<typeof RoleToolPolicy.decide>[0]> | null;
  dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult>;
}

const DEFAULT_MAX_RESULT_LENGTH = 16_000;

function parseArgs(raw: string): Record<string, unknown> | Error {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

function stringifyContent(result: AdapterResult): string {
  if (result.data !== undefined) return typeof result.data === 'string' ? result.data : JSON.stringify(result.data);
  if (result.error !== undefined) return JSON.stringify({ success: false, error: result.error });
  return JSON.stringify({ success: result.success });
}

function truncateContent(content: string, maxLength: number): string {
  if (!Number.isFinite(maxLength) || maxLength < 0 || content.length <= maxLength) return content;
  return `${content.slice(0, maxLength)}...[truncated]`;
}

function policyDeniedContent(decision: RoleToolPolicyDecision): string {
  return JSON.stringify({ success: false, error: decision.message, reasonCode: decision.reasonCode });
}

export class ToolDispatcher {
  constructor(
    private readonly adapters: ToolDispatchAdapter[],
    private readonly policy: ToolDispatchPolicy = { maxResultLength: DEFAULT_MAX_RESULT_LENGTH, categoryMaxResultLength: { 'planner-control': Number.MAX_SAFE_INTEGER } },
  ) {}

  async dispatch(envelope: ToolCallEnvelope, context: ToolDispatchContext): Promise<ToolDispatchResult> {
    const adapter = this.adapters.find((candidate) => candidate.handles(envelope.name));
    if (!adapter) return this.errorResult(envelope, `Unknown tool '${envelope.name}'.`);

    const args = parseArgs(envelope.arguments);
    if (args instanceof Error) return this.errorResult(envelope, `Invalid JSON arguments for '${envelope.name}'.`);

    const policyDecision = this.decide(adapter, envelope, args, context);
    if (!policyDecision.allowed) return this.resultFromAdapter(adapter, envelope, { success: false, error: policyDecision.message, metadata: { policyDenied: true } }, policyDeniedContent(policyDecision));

    try {
      const adapterResult = await adapter.dispatch(envelope, args, context);
      return this.resultFromAdapter(adapter, envelope, adapterResult);
    } catch (err) {
      return this.resultFromAdapter(adapter, envelope, { success: false, error: err instanceof Error ? err.message : String(err) });
    }
  }

  private decide(adapter: ToolDispatchAdapter, envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): RoleToolPolicyDecision {
    if (adapter.category === 'analyst') {
      return RoleToolPolicy.assertAnalystSurfaceTool(envelope.name, context.analystSurface ?? 'web-chat');
    }
    const policyInput = adapter.policyInput?.(envelope, args, context) ?? {};
    return RoleToolPolicy.decide({
      role: context.role,
      action: 'invoke',
      surface: context.surface ?? surfaceForCategory(adapter.category),
      toolName: envelope.name,
      knownRuntimeTool: context.knownRuntimeTool?.(envelope.name),
      knownPlannerTool: context.knownPlannerTool?.(envelope.name),
      contractTerminals: context.contractTerminals,
      ...policyInput,
    });
  }

  private resultFromAdapter(adapter: ToolDispatchAdapter, envelope: ToolCallEnvelope, result: AdapterResult, explicitContent?: string): ToolDispatchResult {
    const maxLength = this.policy.categoryMaxResultLength?.[adapter.category] ?? this.policy.maxResultLength;
    const content = truncateContent(explicitContent ?? stringifyContent(result), maxLength);
    const tool = typeof result.metadata?.toolName === 'string' ? result.metadata.toolName : envelope.name;
    return { role: 'tool', kind: result.success ? 'tool_result' : 'tool_error', content, tool, tool_call_id: envelope.id, adapterResult: result };
  }

  private errorResult(envelope: ToolCallEnvelope, error: string): ToolDispatchResult {
    return { role: 'tool', kind: 'tool_error', content: JSON.stringify({ success: false, error }), tool: envelope.name, tool_call_id: envelope.id };
  }
}

function surfaceForCategory(category: string): RoleToolPolicySurface {
  if (category === 'runtime') return 'agent-runtime';
  if (category === 'planner-control') return 'planner-control';
  if (category === 'mcp') return 'external-mcp';
  if (category === 'skill') return 'skill';
  if (category === 'workspace') return 'workspace';
  if (category === 'contract-terminal') return 'contract-terminal';
  return 'agent-runtime';
}

export class RuntimeToolAdapter implements ToolDispatchAdapter {
  readonly category = 'runtime';

  constructor(private readonly projectRoot: string, private readonly toolRuntime: ToolRuntime<typeof AGENT_TOOL_DEFINITIONS>) {}

  handles(toolName: string): boolean { return this.toolRuntime.has(toolName); }

  async dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult> {
    const result = await this.toolRuntime.invoke({ name: envelope.name, input: args, role: context.role, correlationId: envelope.id, projectRoot: this.projectRoot, sessionId: context.sessionId });
    if (!result.ok) return { success: false, data: { success: false, error: result.error.message, tool_error: result.error } };
    const output = result.output as ToolResult;
    return { success: output.success, data: output };
  }
}

export class PlannerControlAdapter implements ToolDispatchAdapter {
  readonly category = 'planner-control';

  constructor(private readonly executor: PlannerControlExecutor) {}

  handles(toolName: string): boolean { return PlannerControlExecutor.handles(toolName); }

  async dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult> {
    const result = await this.executor.execute({ sessionId: context.sessionId, toolCallId: envelope.id, toolName: envelope.name, args, parentCardId: context.cardId ?? context.goalId });
    return { success: result.success, data: result.data, error: result.error };
  }
}

export class McpAdapter implements ToolDispatchAdapter {
  readonly category = 'mcp';

  constructor(private readonly getMcpManager: () => McpToolInvocationPort | undefined, private readonly getContentSupervisor: () => ContentSupervisor | undefined) {}

  handles(toolName: string): boolean { return toolName === 'mcp_tool_call'; }

  policyInput(_envelope: ToolCallEnvelope, args: Record<string, unknown>): Partial<Parameters<typeof RoleToolPolicy.decide>[0]> {
    const serverName = typeof args.serverName === 'string' ? args.serverName : '';
    const toolName = typeof args.toolName === 'string' ? args.toolName : '';
    const capability = this.getMcpManager()?.findToolCapability(serverName, toolName);
    return { serverName, hasMcpDefinition: Boolean(capability), mcpAnnotations: capability?.annotations };
  }

  async dispatch(_envelope: ToolCallEnvelope, args: Record<string, unknown>): Promise<AdapterResult> {
    const serverName = typeof args.serverName === 'string' ? args.serverName : '';
    const toolName = typeof args.toolName === 'string' ? args.toolName : '';
    const toolArgs = args.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args as Record<string, unknown> : {};
    const displayName = `mcp_tool_call:${serverName}/${toolName}`;
    if (!serverName || !toolName) return { success: false, error: 'mcp_tool_call requires both "serverName" and "toolName" parameters.', metadata: { toolName: 'mcp_tool_call' } };
    const mcpManager = this.getMcpManager();
    if (!mcpManager) return { success: false, error: 'MCP manager not configured. Call setMcpManager() first.', metadata: { toolName: displayName } };
    try {
      const result = await mcpManager.invokeTool(serverName, toolName, toolArgs);
      const contentSupervisor = this.getContentSupervisor();
      if (contentSupervisor && !contentSupervisor.isScreeningDisabled()) {
        const screenResult = await contentSupervisor.screenContent({ sourceKind: 'tool', sourceRef: `mcp:${serverName}/${toolName}`, content: JSON.stringify(result) });
        if (screenResult.status === 'blocked') return { success: false, error: `MCP tool response blocked by content supervisor: ${screenResult.summary}`, metadata: { toolName: displayName } };
      }
      return { success: true, data: result, metadata: { toolName: displayName } };
    } catch (err) {
      const message = err instanceof McpInvokeError || err instanceof Error ? err.message : String(err);
      return { success: false, error: `MCP tool call failed: ${message}`, metadata: { toolName: displayName } };
    }
  }

}

export class SkillAdapter implements ToolDispatchAdapter {
  readonly category = 'skill';

  constructor(private readonly getSkillsEngine: () => SkillsEngine | undefined) {}

  handles(toolName: string): boolean { return toolName === 'skill'; }

  async dispatch(_envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult> {
    const skillName = typeof args.name === 'string' ? args.name : '';
    const displayName = skillName ? `skill:${skillName}` : 'skill:list';
    try {
      const skillsEngine = this.getSkillsEngine();
      if (!skillsEngine) throw new Error('SkillsEngine not configured. Call setSkillsEngine() first.');
      if (!skillName) {
        const skills = skillsEngine.loadIndex().map((entry) => ({
          name: entry.name,
          target_agents: entry.target_agents,
          triggers: entry.triggers,
          updated_at: entry.updated_at,
        }));
        return { success: true, data: { skills }, metadata: { toolName: displayName } };
      }
      const result = await loadSkill(skillName, context.role, skillsEngine);
      return { success: true, data: result.skill_content, metadata: { toolName: displayName } };
    } catch (err) {
      const message = err instanceof LoadSkillError ? err.message : `Error loading skill '${skillName}': ${err instanceof Error ? err.message : String(err)}`;
      return { success: false, error: message, metadata: { toolName: displayName } };
    }
  }
}

export class WorkspaceAdapter implements ToolDispatchAdapter {
  readonly category = 'workspace';

  constructor(private readonly projectRoot: string) {}

  handles(toolName: string): boolean { return toolName === 'read' || toolName === 'write' || toolName === 'glob' || toolName === 'grep' || toolName === 'edit' || toolName === 'apply_patch' || toolName === 'wait_for_process' || toolName === 'kill_process' || toolName === 'run_project_command' || toolName === 'start_and_wait'; }

  async dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult> {
    const result = await processWorkspaceToolCall(envelope.name, JSON.stringify(args), { projectRoot: this.projectRoot, sessionId: context.sessionId, goalId: context.goalId, cardId: context.cardId });
    return { success: true, data: result };
  }
}

export class AnalystAdapter implements ToolDispatchAdapter {
  readonly category = 'analyst';

  handles(toolName: string): boolean { return true; }

  async dispatch(envelope: ToolCallEnvelope, args: Record<string, unknown>, context: ToolDispatchContext): Promise<AdapterResult> {
    const toolFn = TOOL_REGISTRY[envelope.name];
    if (!toolFn) {
      const result = toolFailure('not_found', ANALYST_UNKNOWN_CAPABILITY_TEMPLATE(envelope.name), { tool: envelope.name });
      return { success: false, data: result };
    }
    if (!context.toolContext) return { success: false, data: toolFailure('internal', 'Analyst tool context is not configured.', { tool: envelope.name }) };
    try {
      const result = await toolFn(context.toolContext, args);
      return { success: result.success, data: result };
    } catch (err) {
      return { success: false, data: toolFailureFromError(err) };
    }
  }
}

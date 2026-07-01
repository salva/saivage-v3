import type { ControlActionSurface, OperationalAgentRole } from '../schemas/index.js';
import type { ToolResult, ToolContext } from '../tools/analyst-tool-types.js';
import { toolFailure, toolFailureFromError } from '../tools/analyst-tool-helpers.js';
import { ANALYST_UNKNOWN_CAPABILITY_TEMPLATE } from './analyst-tool-runner.js';
import { RoleToolPolicy, type RoleToolPolicyDecision, type RoleToolPolicySurface } from './role-tool-policy.js';
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
  role: OperationalAgentRole;
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

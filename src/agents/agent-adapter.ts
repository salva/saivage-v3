import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { loadConfig, getRuntimeConfig, getModelParamsForRole, getSelfCheckThreshold } from './config-schema.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { ModelRouter } from './model-router.js';
import { parsePlannerResult, parseExecutorResult, parseReviewerResult, buildExecutorFallbackResult, type PlannerResult, type ExecutorResult, type ReviewerResult } from './result-parser.js';
import { createSession, completeSession, appendMessage, getSession, getSessionMessages, listSessions, updateSessionModel } from './session-persistence.js';
import type { AgentMessage, HandoffSummary, NotificationRecord } from '../schemas/types.js';
import { compactSession } from './compaction.js';
import { invokeWithRecovery, type RecoveryContext } from './recovery.js';
import type { ContentSupervisor } from '../utils/content-supervisor.js';
import { getSafeFileForAgent, redactCredentialLiterals, type SafeFileResult } from '../utils/file-access-security.js';
import type { AgentRuntime } from './agent-runtime.js';
import { LlmClient } from './llm-client.js';
import type { LlmCompleteOptions, ToolDefinition } from './llm-client.js';
import { resolveLlmTransportConfig } from './llm-transport.js';
import { EventLogger } from '../utils/event-logger.js';
import { buildSelfCheckPrompt } from './system-prompt.js';
import type { McpManager, McpToolDefinition } from '../mcp/mcp-manager.js';
import { SkillsEngine } from './skills-engine.js';
import { loadSkill, LoadSkillError, LOAD_SKILL_TOOL_DEFINITION } from './skill-tools.js';
import { processWorkspaceToolCall, READ_ONLY_WORKSPACE_TOOL_DEFINITIONS, WORKSPACE_TOOL_DEFINITIONS } from './workspace-tools.js';
import { NotificationCenter } from '../utils/notification-center.js';
import * as analystTools from './analyst-tools.js';
import { ANALYST_TOOL_DEFINITIONS } from './analyst-tool-schemas.js';
import { CardStore } from '../utils/card-store.js';
import { PlannerToolError, PlannerToolsService } from '../utils/planner-tools.js';

export type { AgentRuntime } from './agent-runtime.js';
export type AgentRole = 'planner' | 'executor' | 'reviewer' | 'analyst';
export interface AgentAdapterConfig { projectRoot: string; saivageDir: string; config: SaivageConfig; eventBus?: EventEmitter; eventLogger?: EventLogger; }
export type LlmCallFn = (candidate: Candidate, systemPrompt: string, messages: AgentMessage[], sessionId: string, opts?: LlmCompleteOptions) => Promise<string>;
type SessionCreatedHook = (sessionId: string) => void | Promise<void>;

const MCP_TOOL_CALL_TOOL_DEFINITION: ToolDefinition = { type: 'function', function: { name: 'mcp_tool_call', description: 'Call an approved MCP (Model Context Protocol) tool on a configured MCP server. Availability is role- and policy-scoped at runtime.', parameters: { type: 'object', properties: { serverName: { type: 'string', description: 'Configured MCP server name' }, toolName: { type: 'string', description: 'Tool name on that MCP server' }, args: { type: 'object', description: 'Optional tool arguments', additionalProperties: true } }, required: ['serverName', 'toolName'], additionalProperties: false } } };

function str(description: string): Record<string, unknown> { return { type: 'string', description }; }
function arr(items: Record<string, unknown>, description?: string): Record<string, unknown> { const result: Record<string, unknown> = { type: 'array', items }; if (description) result.description = description; return result; }
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolDefinition {
  return { type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } };
}

const PLANNER_TOOL_DEFINITIONS: ToolDefinition[] = [
  tool('activate_card', 'Activate a card so runtime can proceed with the next planner-controlled step.', { cardId: str('The ID of the card to activate.') }, ['cardId']),
  tool('cancel_card', 'Cancel a planner-managed card.', { cardId: str('The ID of the card to cancel.') }, ['cardId']),
  tool('delete_card', 'Delete a cancelled or terminal card.', { cardId: str('The ID of the card to delete.') }, ['cardId']),
  tool('restart_card', 'Restart a terminal card so it can be activated again.', { cardId: str('The ID of the card to restart.') }, ['cardId']),
  tool('report_goal_done', 'Report a goal or project as done. Requires non-empty status_text and optional evidence_card_ids.', {
    goalId: str('The goal or project card ID to report done.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting completion.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
  tool('report_goal_failed', 'Report a goal or project as failed. Requires non-empty status_text.', {
    goalId: str('The goal or project card ID to report failed.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting the report.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
  tool('report_goal_blocked', 'Report a goal or project as blocked. Requires non-empty status_text.', {
    goalId: str('The goal or project card ID to report blocked.'),
    status_text: str('Required concise terminal status shown on the goal card.'),
    summary: str('Optional summary for the goal self-report.'),
    evidence_card_ids: arr(str('A descendant done card ID.'), 'Optional evidence card IDs supporting the report.'),
    report: { type: 'object', description: 'Optional full self-report payload.', additionalProperties: true },
  }, ['goalId', 'status_text']),
];

const AGENT_TOOL_NAMES_BY_ROLE: Record<AgentRole, string[]> = {
  analyst: ['list_card_history','get_card_history_entry','diff_card','list_notes','get_note','mark_note_handled','acknowledge_notification'],
  planner: ['list_card_history','get_card_history_entry','diff_card','list_notes','get_note','mark_note_handled'],
  executor: ['list_card_history','get_card_history_entry','diff_card','list_notes','get_note','mark_note_handled','acknowledge_notification'],
  reviewer: ['list_card_history','get_card_history_entry','diff_card','list_notes','get_note','mark_note_handled','acknowledge_notification'],
};

const TOOL_MATRIX: Record<AgentRole, ToolDefinition[]> = {
  planner: [LOAD_SKILL_TOOL_DEFINITION, ...READ_ONLY_WORKSPACE_TOOL_DEFINITIONS, ...ANALYST_TOOL_DEFINITIONS.filter((tool) => AGENT_TOOL_NAMES_BY_ROLE.planner.includes(tool.function.name)), ...PLANNER_TOOL_DEFINITIONS, MCP_TOOL_CALL_TOOL_DEFINITION],
  executor: [LOAD_SKILL_TOOL_DEFINITION, ...WORKSPACE_TOOL_DEFINITIONS, ...ANALYST_TOOL_DEFINITIONS.filter((tool) => AGENT_TOOL_NAMES_BY_ROLE.executor.includes(tool.function.name)), MCP_TOOL_CALL_TOOL_DEFINITION],
  reviewer: [LOAD_SKILL_TOOL_DEFINITION, ...READ_ONLY_WORKSPACE_TOOL_DEFINITIONS, ...ANALYST_TOOL_DEFINITIONS.filter((tool) => AGENT_TOOL_NAMES_BY_ROLE.reviewer.includes(tool.function.name)), MCP_TOOL_CALL_TOOL_DEFINITION],
  analyst: [...ANALYST_TOOL_DEFINITIONS.filter((tool) => AGENT_TOOL_NAMES_BY_ROLE.analyst.includes(tool.function.name))],
};

const RUNTIME_AGENT_TOOL_REGISTRY: Record<string, (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>> = {
  list_card_history: analystTools.list_card_history as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  get_card_history_entry: analystTools.get_card_history_entry as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  diff_card: analystTools.diff_card as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  list_notes: analystTools.list_notes as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  get_note: analystTools.get_note as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  mark_note_handled: analystTools.mark_note_handled as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
  acknowledge_notification: analystTools.acknowledge_notification as unknown as (ctx: analystTools.ToolContext, params: Record<string, unknown>) => Promise<analystTools.ToolResult>,
};

function buildPlannerToolErrorResponse(error: unknown): { success: false; tool_error?: { kind: string; message: string; payload?: Record<string, unknown> }; error?: string } {
  if (error instanceof PlannerToolError) return { success: false, tool_error: { kind: error.kind, message: error.message, ...(error.payload ? { payload: error.payload } : {}) } };
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export class AgentAdapter implements AgentRuntime {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  readonly notificationCenter: NotificationCenter;
  eventBus?: EventEmitter;
  readonly eventLogger?: EventLogger;
  private llmCallFn: LlmCallFn | null = null;
  private contentSupervisor?: ContentSupervisor;
  private llmClientCache: Map<string, LlmClient> = new Map();
  private _abortControllers: Map<string, AbortController> = new Map();
  private _cancelledSessions: Set<string> = new Set();
  private _mcpManager: McpManager | undefined;
  private _skillsEngine: SkillsEngine | undefined;
  private roundCounters: Map<string, number> = new Map();
  private lastRole: string | null = null;
  private afterSessionCreatedHook: SessionCreatedHook | null = null;

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.router = new ModelRouter(cfg.config, this.registry, cfg.projectRoot);
    this.notificationCenter = new NotificationCenter(cfg.projectRoot);
    this.eventBus = cfg.eventBus;
    this.eventLogger = cfg.eventLogger;
  }

  setEventBus(eventBus: EventEmitter): void { this.eventBus = eventBus; }
  setLlmCallFn(fn: LlmCallFn): void { this.llmCallFn = fn; }
  setContentSupervisor(supervisor: ContentSupervisor): void { this.contentSupervisor = supervisor; }
  getContentSupervisor(): ContentSupervisor | undefined { return this.contentSupervisor; }
  setMcpManager(mcpManager: McpManager): void { this._mcpManager = mcpManager; }
  getMcpManager(): McpManager | undefined { return this._mcpManager; }
  setSkillsEngine(engine: SkillsEngine): void { this._skillsEngine = engine; }
  getSkillsEngine(): SkillsEngine | undefined { return this._skillsEngine; }
  setAfterSessionCreatedHook(hook: SessionCreatedHook | null): void { this.afterSessionCreatedHook = hook; }

  public getToolNamesForRole(role: AgentRole): string[] { return this.buildToolsForRole(role).map((tool) => tool.function.name); }
  private buildToolsForRole(role: AgentRole): ToolDefinition[] { return TOOL_MATRIX[role] ?? []; }
  private getMcpToolDefinition(serverName: string, toolName: string): McpToolDefinition | null { if (!this._mcpManager) return null; const tools = this._mcpManager.getServerTools(serverName); return tools?.find((tool) => tool.name === toolName) ?? null; }
  private isMcpToolAllowed(role: AgentRole, definition: McpToolDefinition | null): boolean { if (role === 'analyst') return false; if (role === 'executor') return true; if (!definition) return false; const annotations = definition.annotations ?? {}; const readOnly = annotations.readOnlyHint === true; const destructive = annotations.destructiveHint === true; return readOnly && !destructive; }

  async callMcpTool(role: AgentRole, serverName: string, toolName: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this._mcpManager) throw new Error('MCP manager not configured. Call setMcpManager() first.');
    const { McpInvokeError } = await import('../mcp/mcp-manager.js');
    const toolDefinition = this.getMcpToolDefinition(serverName, toolName);
    if (!this.isMcpToolAllowed(role, toolDefinition)) throw new Error(`Role '${role}' is not permitted to call MCP tool '${serverName}/${toolName}'.`);
    let result: unknown;
    try { result = await this._mcpManager.invokeTool(serverName, toolName, args); } catch (err) { if (err instanceof McpInvokeError) throw err; throw new Error(`MCP tool invocation failed for '${toolName}' on '${serverName}': ${err instanceof Error ? err.message : String(err)}`); }
    if (this.contentSupervisor && !this.contentSupervisor.isScreeningDisabled()) {
      const screenResult = await this.contentSupervisor.screenContent({ sourceKind: 'tool', sourceRef: `mcp:${serverName}/${toolName}`, content: JSON.stringify(result) });
      if (screenResult.status === 'blocked') throw new Error(`MCP tool response blocked by content supervisor: ${screenResult.summary}`);
    }
    return result;
  }

  getSafeFileContent(filePath: string, content: string): SafeFileResult { return getSafeFileForAgent(filePath, content); }
  private applySelfCheck(role: AgentRole, systemPrompt: string, sessionId: string): string { const key = role; const current = (this.roundCounters.get(key) ?? 0) + 1; this.roundCounters.set(key, current); const threshold = getSelfCheckThreshold(this.config, role); if (threshold <= 0 || current % threshold !== 0) return systemPrompt; const selfCheckPrompt = buildSelfCheckPrompt(role, current, threshold); const modifiedPrompt = systemPrompt + '\n\n' + selfCheckPrompt; if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'self_check_triggered', session_id: sessionId, role: role as unknown as import('../schemas/types.js').AgentRole, rounds: current, threshold }); if (this.eventBus) this.eventBus.emit('self_check_triggered', { session_id: sessionId, role, rounds: current, threshold }); return modifiedPrompt; }
  private resetOnRoleChange(role: AgentRole): void { if (this.lastRole !== null && this.lastRole !== role) this.roundCounters.clear(); this.lastRole = role; }
  cancelSession(sessionId: string): boolean { const controller = this._abortControllers.get(sessionId); if (!controller) return false; controller.abort(); this._abortControllers.delete(sessionId); this._cancelledSessions.add(sessionId); if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'session_cancelled', session_id: sessionId }); if (this.eventBus) this.eventBus.emit('session_cancelled', { session_id: sessionId }); return true; }
  forceCancelSession(sessionId: string): boolean { const controller = this._abortControllers.get(sessionId); if (controller) { controller.abort(); this._abortControllers.delete(sessionId); } this._cancelledSessions.add(sessionId); if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'session_force_cancelled', session_id: sessionId }); if (this.eventBus) this.eventBus.emit('session_force_cancelled', { session_id: sessionId }); return controller !== undefined; }
  getHandoffSummary(sessionId: string): HandoffSummary | null { try { const session = getSession(this.saivageDir, sessionId); if (!session || session.status !== 'active') return null; const messages = getSessionMessages(this.saivageDir, sessionId); const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user'); const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant'); return { session_id: sessionId, role: session.role as HandoffSummary['role'], last_action: lastAssistantMsg ? `Produced response: ${lastAssistantMsg.content.substring(0, 200)}` : 'Session started', next_action: lastUserMsg ? `Processing: ${lastUserMsg.content.substring(0, 200)}` : 'Awaiting user input', context_summary: `Goal: ${session.goal_card_id ?? 'N/A'}, Card: ${session.card_id ?? 'N/A'}` }; } catch { return null; } }
  getActiveSessionHandoffs(): HandoffSummary[] { try { const ids = listSessions(this.saivageDir); const summaries: HandoffSummary[] = []; for (const id of ids) { const summary = this.getHandoffSummary(id); if (summary) summaries.push(summary); } return summaries; } catch { return []; } }
  async invokePlanner(goalId: string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<PlannerResult> { return this.invokeAgent('planner', goalId, goalId, systemPrompt, contextMessages, parsePlannerResult); }
  async invokeExecutor(cardId: string, goalId: string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<ExecutorResult> { return this.invokeAgent('executor', goalId, cardId, systemPrompt, contextMessages, parseExecutorResult); }
  async invokeReviewer(goalId: string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<ReviewerResult> { return this.invokeAgent('reviewer', goalId, goalId, systemPrompt, contextMessages, parseReviewerResult); }
  async reinvokeSession(sessionId: string, systemPrompt: string = '', contextMessages: AgentMessage[] = []): Promise<ExecutorResult | ReviewerResult> { const session = getSession(this.saivageDir, sessionId); if (!session) throw new Error(`Session not found: ${sessionId}`); if (session.role === 'executor') return this.invokeExecutor(session.card_id ?? session.goal_card_id ?? '', session.goal_card_id ?? '', systemPrompt, contextMessages); if (session.role === 'reviewer') return this.invokeReviewer(session.goal_card_id ?? '', systemPrompt, contextMessages); throw new Error(`Session '${sessionId}' is not reinvokable.`); }
  private parseToolCallsFromResponse(rawResponse: string): Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null { try { const parsed = JSON.parse(rawResponse); if (parsed && typeof parsed === 'object' && Array.isArray(parsed.toolCalls) && parsed.toolCalls.length > 0) return parsed.toolCalls; } catch {} return null; }

  private async processToolCall(tc: { id: string; type: string; function: { name: string; arguments: string } }, role: AgentRole, sessionId: string, invocation?: { goalId?: string; cardId?: string }): Promise<{ role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string; tool_call_id: string }> {
    if (RUNTIME_AGENT_TOOL_REGISTRY[tc.function.name]) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      try {
        const result = await RUNTIME_AGENT_TOOL_REGISTRY[tc.function.name]({ projectRoot: this.projectRoot, actor: role, surface: 'runtime', sessionId }, args);
        return { role: 'tool', kind: result.success ? 'tool_result' : 'tool_error', content: JSON.stringify(result), tool: tc.function.name, tool_call_id: tc.id };
      } catch (err) {
        return { role: 'tool', kind: 'tool_error', content: JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }), tool: tc.function.name, tool_call_id: tc.id };
      }
    }
    if (role === 'planner' && PLANNER_TOOL_DEFINITIONS.some((tool) => tool.function.name === tc.function.name)) {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      const plannerTools = new PlannerToolsService(new CardStore(this.projectRoot));
      try {
        let result: unknown;
        switch (tc.function.name) {
          case 'activate_card':
            // activate_card is the caller edge between a parent planner session and child work.
            // Leave this tool call unresolved while runtime executes/unwinds the child; runtime
            // appends the matching tool_result exactly once using the real tool_call_id.
            result = { __saivage_defer_tool_result: true, cardId: String(args.cardId ?? '') };
            break;
          case 'cancel_card':
            result = { success: true, card: plannerTools.cancelCard(String(args.cardId ?? '')) };
            break;
          case 'delete_card':
            plannerTools.deleteCard(String(args.cardId ?? ''));
            result = { success: true, deleted: true, cardId: String(args.cardId ?? '') };
            break;
          case 'restart_card':
            result = { success: true, card: plannerTools.restartCard(String(args.cardId ?? '')) };
            break;
          case 'report_goal_done':
          case 'report_goal_failed':
          case 'report_goal_blocked':
            result = plannerTools.reportGoal(tc.function.name, String(args.goalId ?? invocation?.goalId ?? ''), {
              status_text: String(args.status_text ?? ''),
              summary: typeof args.summary === 'string' ? args.summary : undefined,
              evidence_card_ids: Array.isArray(args.evidence_card_ids) ? args.evidence_card_ids.map((value) => String(value)) : undefined,
              report: typeof args.report === 'object' && args.report !== null ? args.report as Record<string, unknown> : undefined,
            }, sessionId);
            break;
          default:
            result = null;
        }
        return { role: 'tool', kind: 'tool_result', content: typeof result === 'string' ? result : JSON.stringify(result), tool: tc.function.name, tool_call_id: tc.id };
      } catch (err) {
        return { role: 'tool', kind: 'tool_error', content: JSON.stringify(buildPlannerToolErrorResponse(err)), tool: tc.function.name, tool_call_id: tc.id };
      }
    }
    if (tc.function.name === 'mcp_tool_call') {
      let args: { serverName?: string; toolName?: string; args?: Record<string, unknown> } = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      const serverName = args.serverName ?? '';
      const toolName = args.toolName ?? '';
      const toolArgs = args.args ?? {};
      if (!serverName || !toolName) return { role: 'tool', kind: 'tool_error', content: 'mcp_tool_call requires both "serverName" and "toolName" parameters.', tool: 'mcp_tool_call', tool_call_id: tc.id };
      try { const result = await this.callMcpTool(role, serverName, toolName, toolArgs); return { role: 'tool', kind: 'tool_result', content: typeof result === 'string' ? result : JSON.stringify(result), tool: `mcp_tool_call:${serverName}/${toolName}`, tool_call_id: tc.id }; } catch (err) { const errorMsg = err instanceof Error ? err.message : String(err); return { role: 'tool', kind: 'tool_error', content: `MCP tool call failed: ${errorMsg}`, tool: `mcp_tool_call:${serverName}/${toolName}`, tool_call_id: tc.id }; }
    }
    if (tc.function.name === 'load_skill') {
      let args: { name?: string } = {};
      try { args = JSON.parse(tc.function.arguments); } catch {}
      const skillName = args.name ?? '';
      try { if (!this._skillsEngine) throw new Error('SkillsEngine not configured. Call setSkillsEngine() first.'); const result = await loadSkill(skillName, role, this._skillsEngine); return { role: 'tool', kind: 'tool_result', content: result.skill_content, tool: `load_skill:${skillName}`, tool_call_id: tc.id }; } catch (err) { const errorMsg = err instanceof LoadSkillError ? err.message : `Error loading skill '${skillName}': ${err instanceof Error ? err.message : String(err)}`; return { role: 'tool', kind: 'tool_error', content: errorMsg, tool: `load_skill:${skillName}`, tool_call_id: tc.id }; }
    }
    if (tc.function.name === 'list_project_files' || tc.function.name === 'read_project_file' || tc.function.name === 'write_project_file' || tc.function.name === 'run_project_command') {
      try { if (role !== 'executor' && (tc.function.name === 'write_project_file' || tc.function.name === 'run_project_command')) throw new Error(`${tc.function.name} is only available to executor agents.`); const result = await processWorkspaceToolCall(tc.function.name, tc.function.arguments, { projectRoot: this.projectRoot, sessionId, goalId: invocation?.goalId, cardId: invocation?.cardId }); return { role: 'tool', kind: 'tool_result', content: typeof result === 'string' ? result : JSON.stringify(result), tool: tc.function.name, tool_call_id: tc.id }; } catch (err) { return { role: 'tool', kind: 'tool_error', content: `${tc.function.name} failed: ${err instanceof Error ? err.message : String(err)}`, tool: tc.function.name, tool_call_id: tc.id }; }
    }
    return { role: 'tool', kind: 'tool_error', content: `Unknown tool '${tc.function.name}'.`, tool: tc.function.name, tool_call_id: tc.id };
  }

  private formatNotificationGuidance(notification: NotificationRecord): string {
    const related = [notification.related_card_id ? `card=${notification.related_card_id}` : null, notification.related_note_id ? `note=${notification.related_note_id}` : null, notification.related_process_id ? `process=${notification.related_process_id}` : null, notification.related_version_seq ? `version=${notification.related_version_seq}` : null].filter(Boolean).join(', ');
    return `- [${notification.kind}] severity=${notification.severity} ${notification.payload_summary}${related ? ` (${related})` : ''}. Use list_card_history/get_card_history_entry/diff_card/list_notes/get_note as needed, then acknowledge_notification("${notification.id}") once adjusted.`;
  }

  private buildNotificationInjectionMessage(notifications: NotificationRecord[], sessionId: string): AgentMessage { const lines = ['## Operator updates since your last turn', '', ...notifications.map((notification) => this.formatNotificationGuidance(notification))]; return { id: `msg-${sessionId}-notification-injection`, session_id: sessionId, role: 'user', kind: 'text', content: lines.join('\n'), timestamp: new Date().toISOString() }; }
  private buildModelMessages(sessionId: string): { messages: AgentMessage[]; drainedIds: string[] } { const pending = this.notificationCenter.drainPendingForSession(sessionId); const baseMessages = getSessionMessages(this.saivageDir, sessionId); if (pending.length === 0) return { messages: baseMessages, drainedIds: [] }; return { messages: [this.buildNotificationInjectionMessage(pending, sessionId), ...baseMessages], drainedIds: pending.map((notification) => notification.id) }; }
  private async handleToolCallsLoop(rawResponse: string, role: AgentRole, sessionId: string, candidate: Candidate, systemPrompt: string, modelParams: { temperature: number; maxTokens: number }, abortController: AbortController, invocation?: { goalId?: string; cardId?: string }): Promise<{ response: string; transportSucceeded: boolean }> { let currentResponse = rawResponse; const MAX_TOOL_ROUNDS = 5; const previousCalls = new Set<string>(); for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) { const toolCalls = this.parseToolCallsFromResponse(currentResponse); if (!toolCalls) return { response: currentResponse, transportSucceeded: true }; const callFingerprint = toolCalls.map((tc) => `${tc.function.name}:${tc.function.arguments}`).sort().join('||'); if (previousCalls.has(callFingerprint)) { appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `Repeated tool-call fingerprint detected; stopping tool loop as no-progress diagnostic: ${callFingerprint}` }); return { response: currentResponse, transportSucceeded: true }; } previousCalls.add(callFingerprint); appendMessage(this.saivageDir, sessionId, { role: 'assistant', kind: 'tool_call', content: JSON.stringify({ toolCalls }), tool: toolCalls.map((tc) => tc.function.name).join(',') }); const toolMessages: Array<{ role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string; tool_call_id: string }> = []; for (const tc of toolCalls) { const msg = await this.processToolCall(tc, role, sessionId, invocation); if (!(role === 'planner' && tc.function.name === 'activate_card' && msg.content.includes('__saivage_defer_tool_result'))) toolMessages.push(msg); } for (const msg of toolMessages) appendMessage(this.saivageDir, sessionId, { role: msg.role, kind: msg.kind, content: msg.content, tool: msg.tool, tool_call_id: msg.tool_call_id }); if (toolMessages.length === 0 && toolCalls.some((tc) => role === 'planner' && tc.function.name === 'activate_card')) return { response: currentResponse, transportSucceeded: true }; const followUpTools = this.buildToolsForRole(role); const modelMessages = this.buildModelMessages(sessionId).messages; currentResponse = await this.llmCallFn!(candidate, systemPrompt, modelMessages, sessionId, { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal: abortController.signal, ...(followUpTools.length > 0 ? { tools: followUpTools, tool_choice: 'auto' } : {}) }); } appendMessage(this.saivageDir, sessionId, { role: 'system', kind: 'model_issue', content: `Maximum tool-call rounds exceeded (${MAX_TOOL_ROUNDS}); stopping as no-progress diagnostic.` }); return { response: currentResponse, transportSucceeded: true }; }

  private resultBlockedByPendingNotifications(role: AgentRole, parsed: unknown, sessionId: string): boolean {
    if (role !== 'executor' && role !== 'reviewer') return false;
    if (!parsed || typeof parsed !== 'object') return false;
    const status = (parsed as Record<string, unknown>).status;
    if (status !== 'done') return false;
    return this.notificationCenter.hasBlockingPendingForSession(sessionId);
  }

  private buildBlockingAcknowledgementMessage(sessionId: string): AgentMessage {
    const pending = this.notificationCenter.listUnacknowledgedBlockingForSession(sessionId);
    const lines = [
      '## Blocking operator updates still require acknowledgement',
      '',
      'Your previous completion was held because blocking operator notifications are still unacknowledged.',
      'Inspect the canonical history/note tools, acknowledge each blocking notification from this session, then resubmit completion.',
      '',
      ...pending.map((notification) => this.formatNotificationGuidance(notification)),
    ];
    return {
      id: `msg-${sessionId}-blocking-notification-hold`,
      session_id: sessionId,
      role: 'user',
      kind: 'text',
      content: lines.join('\n'),
      timestamp: new Date().toISOString(),
    };
  }

  private async invokeAgent<T>(role: AgentRole, goalId: string, cardId: string, systemPrompt: string, contextMessages: AgentMessage[], parser: (raw: string) => T): Promise<T> {
    if (!this.llmCallFn) throw new Error('No LLM call function registered. Call setLlmCallFn() first.');
    this.resetOnRoleChange(role);
    const candidates = await this.router.resolve(role);
    if (candidates.length === 0) throw new Error(`No healthy candidates available for role '${role}'.`);
    const modelParams = getModelParamsForRole(this.config, role);
    const tools = this.buildToolsForRole(role);
    const tool_choice: 'auto' | undefined = tools.length > 0 ? 'auto' : undefined;
    const session = createSession(this.saivageDir, role as import('../schemas/types.js').AgentRole, goalId, cardId);
    await this.afterSessionCreatedHook?.(session.id);
    if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'session_started', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, goal_id: goalId, card_id: cardId });
    if (this.eventBus) this.eventBus.emit('session_started', { session_id: session.id, role, goal_id: goalId, card_id: cardId });
    systemPrompt = this.applySelfCheck(role, systemPrompt, session.id);
    for (const msg of contextMessages) appendMessage(this.saivageDir, session.id, { role: msg.role, kind: msg.kind, content: msg.content, tool: msg.tool, links: msg.links });
    const recoveryOpts = { recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000, maxRetries: this.runtimeConfig.maxRecoveryRetries ?? 3, publishEvents: true, eventBus: this.eventBus, cardId, goalId, sessionId: session.id, agentRole: role, persistFailure: (error: Error, attempt: number, _ctx: RecoveryContext) => { try { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Agent invocation failed (attempt ${attempt}): ${redactCredentialLiterals(error.message)}` }); } catch {} if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'retry_attempted', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt, directive: _ctx.directive }); if (this.eventBus) this.eventBus.emit('retry_attempted', { session_id: session.id, role, attempt, directive: _ctx.directive }); } };
    const agentFn = async (recoveryCtx: RecoveryContext) => {
      const candidateChain = await this.router.resolve(role);
      let lastError: Error | null = null;
      try {
        for (const candidate of candidateChain) {
          if (this._cancelledSessions.has(session.id)) throw new Error(`Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`);
          if (!this.registry.isHealthy(candidate)) continue;
          try {
            updateSessionModel(this.saivageDir, session.id, candidate.model);
            if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'model_selected', session_id: session.id, provider: candidate.provider, model: candidate.model, role: role as unknown as import('../schemas/types.js').AgentRole });
            if (this.eventBus) this.eventBus.emit('model_selected', { session_id: session.id, provider: candidate.provider, model: candidate.model, role });
            if (recoveryCtx.isRecovery && recoveryCtx.directive) appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_recovered', content: recoveryCtx.directive });
            const compactionResult = await compactSession(this.saivageDir, session.id, { contextLimit: 128000, threshold: this.runtimeConfig.compactionThreshold ?? 0.8, maxCompactions: this.runtimeConfig.maxCompactions ?? 3 });
            if (compactionResult.maxReached) throw new Error(`Max compactions (${this.runtimeConfig.maxCompactions ?? 3}) reached for session ${session.id}. Session must be restarted with fresh context.`);
            if (this.eventLogger && compactionResult.compacted) this.eventLogger.appendEvent({ kind: 'compaction_triggered', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, tokens_before: compactionResult.tokensBefore, tokens_after: compactionResult.tokensAfter });
            if (this.eventBus && compactionResult.compacted) this.eventBus.emit('compaction_triggered', { session_id: session.id, role, tokens_before: compactionResult.tokensBefore, tokens_after: compactionResult.tokensAfter });
            const abortController = new AbortController();
            this._abortControllers.set(session.id, abortController);
            const callStart = Date.now();
            try {
              const llmOpts: LlmCompleteOptions = { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens, signal: abortController.signal, ...(tools.length > 0 ? { tools, tool_choice } : {}) };
              const firstTurn = this.buildModelMessages(session.id);
              const rawResponse = await this.llmCallFn!(candidate, systemPrompt, firstTurn.messages, session.id, llmOpts);
              const loopResult = await this.handleToolCallsLoop(rawResponse, role, session.id, candidate, systemPrompt, modelParams, abortController, { goalId, cardId });
              if (firstTurn.drainedIds.length > 0 && loopResult.transportSucceeded) this.notificationCenter.markDeliveredForSession(session.id, firstTurn.drainedIds);
              let finalResponse = loopResult.response;
              const callDuration = Date.now() - callStart;
              appendMessage(this.saivageDir, session.id, { role: 'assistant', kind: 'text', content: finalResponse });
              let parsed: T;
              try { parsed = parser(finalResponse); } catch (err) { if (role === 'executor') { const fallback = buildExecutorFallbackResult(finalResponse, { cardId, sessionMessages: getSessionMessages(this.saivageDir, session.id) }); if (fallback) { appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Executor result fallback constructed after parse failure: ${err instanceof Error ? redactCredentialLiterals(err.message) : 'unknown parse error'}` }); parsed = fallback as T; } else throw err; } else throw err; }
              while (this.resultBlockedByPendingNotifications(role, parsed, session.id)) {
                appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: 'Terminal result held because blocking operator notifications remain unacknowledged.' });
                const holdMessage = this.buildBlockingAcknowledgementMessage(session.id);
                appendMessage(this.saivageDir, session.id, { role: holdMessage.role, kind: holdMessage.kind, content: holdMessage.content });
                finalResponse = await this.llmCallFn!(candidate, systemPrompt, getSessionMessages(this.saivageDir, session.id), session.id, llmOpts);
                const heldLoopResult = await this.handleToolCallsLoop(finalResponse, role, session.id, candidate, systemPrompt, modelParams, abortController, { goalId, cardId });
                finalResponse = heldLoopResult.response;
                appendMessage(this.saivageDir, session.id, { role: 'assistant', kind: 'text', content: finalResponse });
                parsed = parser(finalResponse);
              }
              this.registry.markSucceeded(candidate);
              if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'invocation_succeeded', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt: recoveryCtx.attempt, duration_ms: callDuration });
              if (this.eventBus) this.eventBus.emit('invocation_succeeded', { session_id: session.id, role, attempt: recoveryCtx.attempt, duration_ms: callDuration });
              this._cancelledSessions.delete(session.id);
              return parsed;
            } finally { this._abortControllers.delete(session.id); }
          } catch (err) {
            this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000);
            lastError = err instanceof Error ? err : new Error(String(err));
            appendMessage(this.saivageDir, session.id, { role: 'system', kind: 'model_issue', content: `Candidate ${candidate.provider}/${candidate.account ?? '_'}/${candidate.model} failed: ${redactCredentialLiterals(lastError.message)}` });
            if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'invocation_failed', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, attempt: recoveryCtx.attempt, error_message: redactCredentialLiterals(lastError.message) });
            if (this.eventBus) this.eventBus.emit('invocation_failed', { session_id: session.id, role, attempt: recoveryCtx.attempt, error_message: redactCredentialLiterals(lastError.message) });
            if (this._cancelledSessions.has(session.id)) { if (this.eventLogger) this.eventLogger.appendEvent({ kind: 'session_cancelled', session_id: session.id, role: role as unknown as import('../schemas/types.js').AgentRole, note: 'Stopped retry loop due to session cancellation' }); throw new Error(`Agent invocation cancelled for session ${session.id}. Role: ${role}, goal: ${goalId}, card: ${cardId}`); }
            continue;
          }
        }
        throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
      } finally { this._cancelledSessions.delete(session.id); }
    };
    const attempts = await invokeWithRecovery(agentFn, recoveryOpts);
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.success && lastAttempt.result !== undefined) { const resultValue = lastAttempt.result as T; const shouldMarkFailed = role === 'executor' && typeof resultValue === 'object' && resultValue !== null && 'status' in (resultValue as Record<string, unknown>) && (resultValue as Record<string, unknown>).status === 'failed'; completeSession(this.saivageDir, session.id, shouldMarkFailed ? 'failed' : 'done'); return resultValue; }
    completeSession(this.saivageDir, session.id, 'failed');
    throw lastAttempt.error ?? new Error(`Agent '${role}' invocation failed after ${attempts.length} attempts.`);
  }

  getRouter(): ModelRouter { return this.router; }
  getRegistry(): ProviderRegistry { return this.registry; }
  createLlmCallFn(): LlmCallFn { const registry = this.registry; const clientCache = this.llmClientCache; const projectRoot = this.projectRoot; return async (candidate: Candidate, systemPrompt: string, messages: AgentMessage[], sessionId: string, opts?: LlmCompleteOptions): Promise<string> => { const { baseUrl, apiKey, cacheKey } = await resolveLlmTransportConfig(projectRoot, registry, candidate); let client = clientCache.get(cacheKey); if (!client) { client = new LlmClient(baseUrl, apiKey); clientCache.set(cacheKey, client); } const result = await client.complete(candidate, systemPrompt, messages, sessionId, opts); return result.content ?? JSON.stringify({ toolCalls: result.toolCalls }); }; }
}

export function createAgentAdapter(projectRoot: string, eventBus?: EventEmitter): AgentAdapter { const saivageDir = `${projectRoot}/.saivage`; const { config, warnings } = loadConfig(projectRoot); if (warnings.length > 0 && eventBus) for (const warning of warnings) eventBus.emit('config_warning', { warning }); return new AgentAdapter({ projectRoot, saivageDir, config, eventBus }); }

/**
 * Agent Adapter — Wires model router, result parsing, session persistence,
 * compaction, and recovery into a cohesive agent invocation layer.
 *
 * This is the integration point between the runtime and the LLM providers.
 * The ActiveRuntime uses this adapter instead of the FakeAgentAdapter when
 * real LLM calls are desired.
 */

import { EventEmitter } from 'node:events';
import type { SaivageConfig, RuntimeSection } from './config-schema.js';
import { loadConfig, getRuntimeConfig, getModelParamsForRole, getSelfCheckThreshold } from './config-schema.js';
import { ProviderRegistry, type Candidate } from './provider.js';
import { ModelRouter } from './model-router.js';
import {
  parsePlannerResult,
  parseExecutorResult,
  parseReviewerResult,
  type PlannerResult,
  type ExecutorResult,
  type ReviewerResult,
} from './result-parser.js';
import {
  createSession,
  completeSession,
  appendMessage,
  getSession,
  getSessionMessages,
  listSessions,
  updateSessionModel,
} from './session-persistence.js';
import type { AgentMessage, HandoffSummary } from '../schemas/types.js';
import { compactSession } from './compaction.js';
import { invokeWithRecovery, type RecoveryContext } from './recovery.js';
import type { ContentSupervisor } from '../utils/content-supervisor.js';
import { getSafeFileForAgent, type SafeFileResult } from '../utils/file-access-security.js';
import type { AgentRuntime } from './agent-runtime.js';
import { LlmClient } from './llm-client.js';
import type { LlmCompleteOptions, ToolDefinition } from './llm-client.js';
import { EventLogger } from '../utils/event-logger.js';
import { buildSelfCheckPrompt } from './system-prompt.js';
import type { McpManager } from '../mcp/mcp-manager.js';
import { SkillsEngine } from './skills-engine.js';
import { loadSkill, LOAD_SKILL_TOOL_DEFINITIONS, LoadSkillError, PERMITTED_ROLES } from './skill-tools.js';

// Re-export the common AgentRuntime interface for consumers that
// need to reference it without importing agent-runtime.ts directly.
export type { AgentRuntime } from './agent-runtime.js';

// ── Types ─────────────────────────────────────────────────────

export type AgentRole = 'planner' | 'executor' | 'reviewer' | 'analyst';

export interface AgentAdapterConfig {
  /** Absolute path to project root */
  projectRoot: string;
  /** Absolute path to .saivage/ directory */
  saivageDir: string;
  /** Loaded and validated config */
  config: SaivageConfig;
  /** Optional event bus for publishing events */
  eventBus?: EventEmitter;
  /** Optional EventLogger for emitting agent events */
  eventLogger?: EventLogger;
}

/**
 * A function that makes an actual LLM API call.
 * The adapter is transport-agnostic; this function handles the actual HTTP call.
 */
export type LlmCallFn = (
  candidate: Candidate,
  systemPrompt: string,
  messages: AgentMessage[],
  sessionId: string,
  opts?: LlmCompleteOptions,
) => Promise<string>;

// ── Agent Adapter ─────────────────────────────────────────────

export class AgentAdapter implements AgentRuntime {
  readonly projectRoot: string;
  readonly saivageDir: string;
  readonly config: SaivageConfig;
  readonly runtimeConfig: RuntimeSection;
  readonly registry: ProviderRegistry;
  readonly router: ModelRouter;
  eventBus?: EventEmitter;
  readonly eventLogger?: EventLogger;

  private llmCallFn: LlmCallFn | null = null;
  private contentSupervisor?: ContentSupervisor;
  private llmClientCache: Map<string, LlmClient> = new Map();

  /** Map of sessionId -> AbortController for in-flight LLM calls */
  private _abortControllers: Map<string, AbortController> = new Map();

  /** Set of session IDs that have been cancelled (blocks retry in candidate loop) */
  private _cancelledSessions: Set<string> = new Set();

  /** MCP manager reference for tool invocation. */
  private _mcpManager: McpManager | undefined;

  /** SkillsEngine reference for on-demand skill loading via load_skill tool. */
  private _skillsEngine: SkillsEngine | undefined;

  // Self-check round tracking
  private roundCounters: Map<string, number> = new Map();
  private lastRole: string | null = null;

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.router = new ModelRouter(cfg.config, this.registry, cfg.projectRoot);
    this.eventBus = cfg.eventBus;
    this.eventLogger = cfg.eventLogger;
  }

  /**
   * Set or replace the event bus after construction.
   * Called by ActiveRuntime to wire the Runtime as the event bus
   * so agent events (session_started, model_selected, etc.) propagate
   * through the Runtime's EventEmitter to WebSocket clients.
   */
  setEventBus(eventBus: EventEmitter): void {
    this.eventBus = eventBus;
  }

  /**
   * Register the function used to make actual LLM API calls.
   * This is decoupled so providers can be swapped without changing the adapter.
   */
  setLlmCallFn(fn: LlmCallFn): void {
    this.llmCallFn = fn;
  }

  /**
   * Set the ContentSupervisor for screening external content before it
   * enters agent contexts. When not set, content screening is bypassed
   * (the adapter works as before).
   */
  setContentSupervisor(supervisor: ContentSupervisor): void {
    this.contentSupervisor = supervisor;
  }

  /**
   * Get the ContentSupervisor if one has been set.
   */
  getContentSupervisor(): ContentSupervisor | undefined {
    return this.contentSupervisor;
  }

  /**
   * Set the McpManager for MCP tool invocation capability.
   * Must be called before callMcpTool() can be used.
   */
  setMcpManager(mcpManager: McpManager): void {
    this._mcpManager = mcpManager;
  }

  /**
   * Get the McpManager if one has been set.
   */
  getMcpManager(): McpManager | undefined {
    return this._mcpManager;
  }

  /**
   * Set the SkillsEngine for on-demand skill loading.
   * Must be called before the load_skill tool can be used by agents.
   */
  setSkillsEngine(engine: SkillsEngine): void {
    this._skillsEngine = engine;
  }

  /**
   * Get the SkillsEngine if one has been set.
   */
  getSkillsEngine(): SkillsEngine | undefined {
    return this._skillsEngine;
  }

  /**
   * Build the list of tool definitions available to a given agent role.
   *
   * Per 07-skills.md §On-Demand Loading: planner, executor, and reviewer
   * agents can call load_skill to load skills mid-session. The analyst role
   * is not permitted and receives an empty tools array.
   */
  private buildToolsForRole(role: AgentRole): ToolDefinition[] {
    if ((PERMITTED_ROLES as readonly string[]).includes(role)) {
      return LOAD_SKILL_TOOL_DEFINITIONS;
    }
    return [];
  }

  /**
   * Invoke an MCP tool on a running server through the McpManager.
   *
   * This is the integration point that agents use to call external
   * MCP tools at execution time. The flow is:
   *
   * 1. Validates that the McpManager has been configured.
   * 2. Dynamically imports the McpManager module (avoiding circular
   *    dependencies at module load time).
   * 3. Calls `McpManager.invokeTool(serverName, toolName, args)`.
   * 4. Screens the result through ContentSupervisor (if configured).
   * 5. Returns the screened result, or throws a structured error.
   *
   * @param serverName - The configured MCP server name.
   * @param toolName   - The tool to invoke.
   * @param args       - Tool arguments as a key-value record.
   * @returns The screened tool result.
   * @throws If the McpManager has not been configured.
   * @throws If the ContentSupervisor blocks the response.
   * @throws McpInvokeError subclasses for MCP-level errors.
   */
  async callMcpTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    // 1. Validate that McpManager is configured
    if (!this._mcpManager) {
      throw new Error(
        'MCP manager not configured. Call setMcpManager() first.',
      );
    }

    // 2. Dynamically import the McpManager module to get error types
    //    for instanceof checks without creating a circular import at
    //    module load time.
    const { McpInvokeError } = await import('../mcp/mcp-manager.js');

    // 3. Call invokeTool on the McpManager
    let result: unknown;
    try {
      result = await this._mcpManager.invokeTool(
        serverName,
        toolName,
        args,
      );
    } catch (err) {
      // McpInvokeError subclasses are already structured — re-throw as-is
      if (err instanceof McpInvokeError) {
        throw err;
      }
      // Wrap unexpected errors
      throw new Error(
        `MCP tool invocation failed for '${toolName}' on '${serverName}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    // 4. Screen the result through ContentSupervisor if configured
    if (this.contentSupervisor && !this.contentSupervisor.isScreeningDisabled()) {
      const screenResult = await this.contentSupervisor.screenContent({
        sourceKind: 'tool',
        sourceRef: `mcp:${serverName}/${toolName}`,
        content: JSON.stringify(result),
      });

      if (screenResult.status === 'blocked') {
        throw new Error(
          `MCP tool response blocked by content supervisor: ${screenResult.summary}`,
        );
      }

      // If sanitized, return the original result (the supervisor
      // doesn't modify content in "sanitized" mode — it just records
      // the pass). For future sanitize-and-rewrite support, we could
      // parse screenResult content here.
    }

    // 5. Return the screened result
    return result;
  }

  /**
   * Check whether a file read by an agent is safe, applying sensitive-file
   * blocking and secret redaction.
   *
   * When the path is blocked (e.g., `.saivage/auth-profiles.json`),
   * returns `blocked: true` with a reason. When the path needs secret
   * redaction (`.saivage/saivage.json`), returns the redacted content.
   * Otherwise returns the content as-is.
   *
   * This is the integration point between the file-access-security module
   * and the agent adapter — agents that read files should use this method
   * to get safe content.
   */
  getSafeFileContent(
    filePath: string,
    content: string,
  ): SafeFileResult {
    return getSafeFileForAgent(filePath, content);
  }

  // ── Self-Check Mechanism ────────────────────────────────────

  /**
   * Check if a self-check is due for this role and inject the prompt.
   * Increments the per-role round counter on every invocation.
   * When the counter reaches the configured threshold (and threshold > 0),
   * appends the self-check prompt to the system prompt and logs an event.
   *
   * Returns the modified system prompt (with self-check appended) or
   * the original system prompt unchanged.
   */
  private applySelfCheck(
    role: AgentRole,
    systemPrompt: string,
    sessionId: string,
  ): string {
    const key = role;
    const current = (this.roundCounters.get(key) ?? 0) + 1;
    this.roundCounters.set(key, current);

    // Get threshold from config (0 = never)
    const threshold = getSelfCheckThreshold(this.config, role);
    if (threshold <= 0) return systemPrompt;

    // Check if threshold is met
    if (current % threshold !== 0) return systemPrompt;

    // Append self-check prompt
    const selfCheckPrompt = buildSelfCheckPrompt(role, current, threshold);
    const modifiedPrompt = systemPrompt + '\n\n' + selfCheckPrompt;

    // Log self_check_triggered event
    if (this.eventLogger) {
      this.eventLogger.appendEvent({
        kind: 'self_check_triggered',
        session_id: sessionId,
        role: role as unknown as import('../schemas/types.js').AgentRole,
        rounds: current,
        threshold,
      });
    }
    if (this.eventBus) {
      this.eventBus.emit('self_check_triggered', {
        session_id: sessionId,
        role,
        rounds: current,
        threshold,
      });
    }

    return modifiedPrompt;
  }

  /**
   * Reset round counters when the role changes between invocations.
   * Called at the start of each invokeAgent call.
   */
  private resetOnRoleChange(role: AgentRole): void {
    if (this.lastRole !== null && this.lastRole !== role) {
      // Role changed — reset all round counters
      this.roundCounters.clear();
    }
    this.lastRole = role;
  }

  // ── Session Cancellation ────────────────────────────────────

  /**
   * Request a graceful cancellation of an in-flight agent session.
   * Aborts the in-flight LLM call via AbortController and adds the
   * session to the cancelled set so the retry loop stops.
   * Returns true if the session was found and abort was triggered.
   */
  cancelSession(sessionId: string): boolean {
    const controller = this._abortControllers.get(sessionId);
    if (!controller) {
      return false;
    }

    controller.abort();
    this._abortControllers.delete(sessionId);
    this._cancelledSessions.add(sessionId);

    // Emit session_cancelled event
    if (this.eventLogger) {
      this.eventLogger.appendEvent({
        kind: 'session_cancelled',
        session_id: sessionId,
      });
    }
    if (this.eventBus) {
      this.eventBus.emit('session_cancelled', { session_id: sessionId });
    }

    return true;
  }

  /**
   * Force-cancel an agent session — a stronger signal than cancelSession.
   * Logs the forced abort, emits a 'session_force_cancelled' event, and
   * adds the session to the cancelled set so the retry loop stops.
   * Returns true if the session was tracked (even if already cleaned up).
   */
  forceCancelSession(sessionId: string): boolean {
    // Try graceful cancel first in case the controller still exists
    const controller = this._abortControllers.get(sessionId);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(sessionId);
    }

    // Add to cancelled set to prevent retry loop from trying new candidates
    this._cancelledSessions.add(sessionId);

    // Emit session_force_cancelled event
    if (this.eventLogger) {
      this.eventLogger.appendEvent({
        kind: 'session_force_cancelled',
        session_id: sessionId,
      });
    }
    if (this.eventBus) {
      this.eventBus.emit('session_force_cancelled', { session_id: sessionId });
    }

    return controller !== undefined;
  }

  // ── Handoff Summary ─────────────────────────────────────────

  /**
   * Get a handoff summary for a specific active session.
   * Reads the session metadata and last message to produce a structured summary.
   * Returns null if the session is not found or not active.
   */
  getHandoffSummary(sessionId: string): HandoffSummary | null {
    try {
      const session = getSession(this.saivageDir, sessionId);
      if (!session || session.status !== 'active') return null;

      // Read the last few messages to build context
      const messages = getSessionMessages(this.saivageDir, sessionId);
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');

      return {
        session_id: sessionId,
        role: session.role as HandoffSummary['role'],
        last_action: lastAssistantMsg
          ? `Produced response: ${lastAssistantMsg.content.substring(0, 200)}`
          : 'Session started',
        next_action: lastUserMsg
          ? `Processing: ${lastUserMsg.content.substring(0, 200)}`
          : 'Awaiting user input',
        context_summary: `Goal: ${session.goal_card_id ?? 'N/A'}, Card: ${session.card_id ?? 'N/A'}`,
      };
    } catch {
      return null;
    }
  }

  /**
   * Get handoff summaries for all currently active sessions.
   * Used by Runtime.freeze() to collect agent checkpoints.
   */
  getActiveSessionHandoffs(): HandoffSummary[] {
    try {
      const ids = listSessions(this.saivageDir);
      const summaries: HandoffSummary[] = [];
      for (const id of ids) {
        const summary = this.getHandoffSummary(id);
        if (summary) summaries.push(summary);
      }
      return summaries;
    } catch {
      return [];
    }
  }

  // ── Invocation Methods ──────────────────────────────────────

  /**
   * Invoke the planner agent for a goal.
   */
  async invokePlanner(
    goalId: string,
    planCardId: string = '',
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<PlannerResult> {
    return this.invokeAgent('planner', goalId, planCardId, systemPrompt, contextMessages, parsePlannerResult);
  }

  /**
   * Invoke the executor agent for a terminal card.
   */
  async invokeExecutor(
    cardId: string,
    goalId: string,
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<ExecutorResult> {
    return this.invokeAgent('executor', goalId, cardId, systemPrompt, contextMessages, parseExecutorResult);
  }

  /**
   * Invoke the reviewer agent for a goal.
   */
  async invokeReviewer(
    goalId: string,
    planCardId: string = '',
    systemPrompt: string = '',
    contextMessages: AgentMessage[] = [],
  ): Promise<ReviewerResult> {
    return this.invokeAgent('reviewer', goalId, planCardId, systemPrompt, contextMessages, parseReviewerResult);
  }

  /**
   * Parse a raw LLM response to check if it is a tool_calls JSON payload.
   *
   * When the LLM calls tools (finish_reason = 'tool_calls'), the content
   * is null and createLlmCallFn serializes the tool calls as:
   *   {"toolCalls": [{id, type, function: {name, arguments}}]}
   *
   * Returns the parsed tool calls array, or null if the response is
   * not a tool_calls payload.
   */
  private parseToolCallsFromResponse(
    rawResponse: string,
  ): Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null {
    try {
      const parsed = JSON.parse(rawResponse);
      if (
        parsed &&
        typeof parsed === 'object' &&
        Array.isArray(parsed.toolCalls) &&
        parsed.toolCalls.length > 0
      ) {
        return parsed.toolCalls;
      }
    } catch {
      // Not JSON — normal text response
    }
    return null;
  }

  /**
   * Process a single tool call and return the tool result message.
   * Handles load_skill and unknown tools.
   */
  private async processToolCall(
    tc: { id: string; type: string; function: { name: string; arguments: string } },
    role: AgentRole,
    sessionId: string,
  ): Promise<{ role: 'tool'; kind: 'tool_result' | 'tool_error'; content: string; tool: string }> {
    if (tc.function.name === 'load_skill') {
      // Parse arguments
      let args: { name?: string } = {};
      try {
        args = JSON.parse(tc.function.arguments);
      } catch {
        // Invalid JSON arguments — treat as missing name
      }

      const skillName = args.name ?? '';

      try {
        if (!this._skillsEngine) {
          throw new Error('SkillsEngine not configured. Call setSkillsEngine() first.');
        }

        const result = await loadSkill(skillName, role, this._skillsEngine);

        return {
          role: 'tool',
          kind: 'tool_result',
          content: result.skill_content,
          tool: `load_skill:${skillName}`,
        };
      } catch (err) {
        const errorMsg = err instanceof LoadSkillError
          ? err.message
          : `Error loading skill '${skillName}': ${err instanceof Error ? err.message : String(err)}`;
        return {
          role: 'tool',
          kind: 'tool_error',
          content: errorMsg,
          tool: `load_skill:${skillName}`,
        };
      }
    }

    // Unknown tool
    return {
      role: 'tool',
      kind: 'tool_error',
      content: `Unknown tool '${tc.function.name}'. Available tools: load_skill.`,
      tool: tc.function.name,
    };
  }

  /**
   * Handle tool calls from the LLM response and re-invoke the LLM
   * with tool results injected into the conversation.
   *
   * This implements a tool-call loop: the LLM may request tools,
   * the runtime executes them, and the LLM continues with the results.
   * The loop has a maximum number of rounds to prevent infinite recursion.
   *
   * @returns The final text response after all tool calls have been resolved.
   */
  private async handleToolCallsLoop(
    rawResponse: string,
    role: AgentRole,
    sessionId: string,
    candidate: Candidate,
    systemPrompt: string,
    modelParams: { temperature: number; maxTokens: number },
    abortController: AbortController,
  ): Promise<string> {
    let currentResponse = rawResponse;
    const MAX_TOOL_ROUNDS = 5;
    // Track calls to detect infinite loops (same tool name + same args)
    const previousCalls = new Set<string>();

    for (let toolRound = 0; toolRound < MAX_TOOL_ROUNDS; toolRound++) {
      const toolCalls = this.parseToolCallsFromResponse(currentResponse);
      if (!toolCalls) {
        // Not a tool_calls response — it's the final text
        return currentResponse;
      }

      // Detect if this exact set of tool calls has been made before
      const callFingerprint = toolCalls
        .map((tc) => `${tc.function.name}:${tc.function.arguments}`)
        .sort()
        .join('||');
      if (previousCalls.has(callFingerprint)) {
        // Same tool calls would repeat — break to prevent infinite loop
        return currentResponse;
      }
      previousCalls.add(callFingerprint);

      // Record the assistant message containing the tool_calls
      appendMessage(this.saivageDir, sessionId, {
        role: 'assistant',
        kind: 'tool_call',
        content: JSON.stringify({ toolCalls }),
        tool: toolCalls.map((tc) => tc.function.name).join(','),
      });

      // Process each tool call and collect tool result messages
      const toolMessages: Array<{
        role: 'tool';
        kind: 'tool_result' | 'tool_error';
        content: string;
        tool: string;
      }> = [];

      for (const tc of toolCalls) {
        const toolMsg = await this.processToolCall(tc, role, sessionId);
        toolMessages.push(toolMsg);
      }

      // Append tool messages to session
      for (const msg of toolMessages) {
        appendMessage(this.saivageDir, sessionId, {
          role: msg.role,
          kind: msg.kind,
          content: msg.content,
          tool: msg.tool,
        });
      }

      // Call LLM again with tool results injected into the conversation
      // Note: we pass tools but NOT tool_choice on follow-up calls —
      // the model should produce a text response after receiving tool results.
      currentResponse = await this.llmCallFn!(
        candidate,
        systemPrompt,
        getSessionMessages(this.saivageDir, sessionId),
        sessionId,
        {
          temperature: modelParams.temperature,
          max_tokens: modelParams.maxTokens,
          signal: abortController.signal,
          // Don't pass tools on follow-up — model has the results
        },
      );
    }

    return currentResponse;
  }

  /**
   * Core agent invocation logic with model routing, session management,
   * compaction, and recovery.
   */
  private async invokeAgent<T>(
    role: AgentRole,
    goalId: string,
    cardId: string,
    systemPrompt: string,
    contextMessages: AgentMessage[],
    parser: (raw: string) => T,
  ): Promise<T> {
    if (!this.llmCallFn) {
      throw new Error('No LLM call function registered. Call setLlmCallFn() first.');
    }

    // Self-check: reset counters on role change and apply self-check prompt
    this.resetOnRoleChange(role);

    // Resolve candidate chain
    const candidates = await this.router.resolve(role);
    if (candidates.length === 0) {
      throw new Error(`No healthy candidates available for role '${role}'.`);
    }

    // Get model params (temperature, max_tokens) for this role
    const modelParams = getModelParamsForRole(this.config, role);

    // Build tool definitions for this role
    const tools = this.buildToolsForRole(role);
    const tool_choice: 'auto' | undefined = tools.length > 0 ? 'auto' : undefined;

    // Create session
    const session = createSession(
      this.saivageDir,
      role as import('../schemas/types.js').AgentRole,
      goalId,
      cardId,
    );

    // Log session_started event
    if (this.eventLogger) {
      this.eventLogger.appendEvent({
        kind: 'session_started',
        session_id: session.id,
        role: role as unknown as import('../schemas/types.js').AgentRole,
        goal_id: goalId,
        card_id: cardId,
      });
    }
    if (this.eventBus) {
      this.eventBus.emit('session_started', {
        session_id: session.id,
        role,
        goal_id: goalId,
        card_id: cardId,
      });
    }

    // Apply self-check to system prompt (after session is created so we have session.id)
    systemPrompt = this.applySelfCheck(role, systemPrompt, session.id);

    // Append context messages to session
    for (const msg of contextMessages) {
      appendMessage(this.saivageDir, session.id, {
        role: msg.role,
        kind: msg.kind,
        content: msg.content,
        tool: msg.tool,
        links: msg.links,
      });
    }

    // Build recovery options
    const recoveryOpts = {
      recoveryDelayMs: this.runtimeConfig.recoveryDelayMs ?? 60000,
      maxRetries: this.runtimeConfig.maxRecoveryRetries ?? 3,
      publishEvents: true,
      eventBus: this.eventBus,
      cardId,
      goalId,
      sessionId: session.id,
      agentRole: role,
      persistFailure: (error: Error, attempt: number, _ctx: RecoveryContext) => {
        // Persist as a session message
        try {
          appendMessage(this.saivageDir, session.id, {
            role: 'system',
            kind: 'model_issue',
            content: `Agent invocation failed (attempt ${attempt}): ${error.message}`,
          });
        } catch {
          // Best effort
        }
        // Log retry_attempted event
        if (this.eventLogger) {
          this.eventLogger.appendEvent({
            kind: 'retry_attempted',
            session_id: session.id,
            role: role as unknown as import('../schemas/types.js').AgentRole,
            attempt,
            directive: _ctx.directive,
          });
        }
        if (this.eventBus) {
          this.eventBus.emit('retry_attempted', {
            session_id: session.id,
            role,
            attempt,
            directive: _ctx.directive,
          });
        }
      },
    };

    // Define the agent function
    const agentFn = async (recoveryCtx: RecoveryContext) => {
      // Try each candidate in order
      const candidateChain = await this.router.resolve(role);
      let lastError: Error | null = null;

      try {
        for (const candidate of candidateChain) {
          // Check if session was cancelled before trying this candidate
          if (this._cancelledSessions.has(session.id)) {
            throw new Error(
              `Agent invocation cancelled for session ${session.id}. ` +
              `Role: ${role}, goal: ${goalId}, card: ${cardId}`,
            );
          }

          // Check if candidate is healthy
          if (!this.registry.isHealthy(candidate)) {
            continue;
          }

          try {
            // Update session model
            updateSessionModel(this.saivageDir, session.id, candidate.model);

            // Log model_selected event
            if (this.eventLogger) {
              this.eventLogger.appendEvent({
                kind: 'model_selected',
                session_id: session.id,
                provider: candidate.provider,
                model: candidate.model,
                role: role as unknown as import('../schemas/types.js').AgentRole,
              });
            }
            if (this.eventBus) {
              this.eventBus.emit('model_selected', {
                session_id: session.id,
                provider: candidate.provider,
                model: candidate.model,
                role,
              });
            }

            // Append recovery directive if this is a retry
            if (recoveryCtx.isRecovery && recoveryCtx.directive) {
              appendMessage(this.saivageDir, session.id, {
                role: 'system',
                kind: 'model_recovered',
                content: recoveryCtx.directive,
              });
            }

            // Check compaction
            const compactionResult = await compactSession(
              this.saivageDir,
              session.id,
              {
                contextLimit: 128000,
                threshold: this.runtimeConfig.compactionThreshold ?? 0.8,
                maxCompactions: this.runtimeConfig.maxCompactions ?? 3,
              },
            );

            if (compactionResult.maxReached) {
              throw new Error(
                `Max compactions (${this.runtimeConfig.maxCompactions ?? 3}) reached for session ${session.id}. ` +
                  `Session must be restarted with fresh context.`,
              );
            }

            // Log compaction_triggered event
            if (this.eventLogger && compactionResult.compacted) {
              this.eventLogger.appendEvent({
                kind: 'compaction_triggered',
                session_id: session.id,
                role: role as unknown as import('../schemas/types.js').AgentRole,
                tokens_before: compactionResult.tokensBefore,
                tokens_after: compactionResult.tokensAfter,
              });
            }
            if (this.eventBus && compactionResult.compacted) {
              this.eventBus.emit('compaction_triggered', {
                session_id: session.id,
                role,
                tokens_before: compactionResult.tokensBefore,
                tokens_after: compactionResult.tokensAfter,
              });
            }

            // Create AbortController for this call so cancelSession can abort it
            const abortController = new AbortController();
            this._abortControllers.set(session.id, abortController);

            // Capture start time for duration measurement
            const callStart = Date.now();

            try {
              // Build LLM opts with tools for this role
              const llmOpts: LlmCompleteOptions = {
                temperature: modelParams.temperature,
                max_tokens: modelParams.maxTokens,
                signal: abortController.signal,
                ...(tools.length > 0 ? { tools, tool_choice } : {}),
              };

              // Make the LLM call with role-specific temperature, max_tokens, tools, and signal
              const rawResponse = await this.llmCallFn!(
                candidate,
                systemPrompt,
                getSessionMessages(this.saivageDir, session.id),
                session.id,
                llmOpts,
              );

              // Handle tool calls: if the LLM requested tools, execute them
              // and loop until we get a final text response
              const finalResponse = await this.handleToolCallsLoop(
                rawResponse,
                role,
                session.id,
                candidate,
                systemPrompt,
                modelParams,
                abortController,
              );

              // Compute actual call duration
              const callDuration = Date.now() - callStart;

              // Record assistant response (the final text, not tool calls)
              appendMessage(this.saivageDir, session.id, {
                role: 'assistant',
                kind: 'text',
                content: finalResponse,
              });

              // Parse the result
              const parsed = parser(finalResponse);

              // Mark candidate as succeeded
              this.registry.markSucceeded(candidate);

              // Log invocation_succeeded event
              if (this.eventLogger) {
                this.eventLogger.appendEvent({
                  kind: 'invocation_succeeded',
                  session_id: session.id,
                  role: role as unknown as import('../schemas/types.js').AgentRole,
                  attempt: recoveryCtx.attempt,
                  duration_ms: callDuration,
                });
              }
              if (this.eventBus) {
                this.eventBus.emit('invocation_succeeded', {
                  session_id: session.id,
                  role,
                  attempt: recoveryCtx.attempt,
                  duration_ms: callDuration,
                });
              }

              // Clean up the cancelled flag — the call succeeded, so cancellation is moot
              this._cancelledSessions.delete(session.id);

              return parsed;
            } finally {
              this._abortControllers.delete(session.id);
            }
          } catch (err) {
            // Mark candidate as failed
            this.registry.markFailed(candidate, this.runtimeConfig.recoveryDelayMs ?? 60000);

            lastError = err instanceof Error ? err : new Error(String(err));

            // Record failure in session
            appendMessage(this.saivageDir, session.id, {
              role: 'system',
              kind: 'model_issue',
              content: `Candidate ${candidate.provider}/${candidate.account ?? '_'}/${candidate.model} failed: ${lastError.message}`,
            });

            // Log invocation_failed event
            if (this.eventLogger) {
              this.eventLogger.appendEvent({
                kind: 'invocation_failed',
                session_id: session.id,
                role: role as unknown as import('../schemas/types.js').AgentRole,
                attempt: recoveryCtx.attempt,
                error_message: lastError.message,
              });
            }
            if (this.eventBus) {
              this.eventBus.emit('invocation_failed', {
                session_id: session.id,
                role,
                attempt: recoveryCtx.attempt,
                error_message: lastError.message,
              });
            }

            // Check if session was cancelled — if so, stop retrying
            if (this._cancelledSessions.has(session.id)) {
              // Emit a clear error that this session was cancelled
              if (this.eventLogger) {
                this.eventLogger.appendEvent({
                  kind: 'session_cancelled',
                  session_id: session.id,
                  role: role as unknown as import('../schemas/types.js').AgentRole,
                  note: 'Stopped retry loop due to session cancellation',
                });
              }
              throw new Error(
                `Agent invocation cancelled for session ${session.id}. ` +
                `Role: ${role}, goal: ${goalId}, card: ${cardId}`,
              );
            }

            // Continue to next candidate
            continue;
          }
        }

        // All candidates exhausted
                throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
      } finally {
        // Clean up cancellation state for this session.
        // This covers:
        // - Pre-candidate cancellation (the check at the top of the loop threw)
        // - Cancellation during an LLM call (the post-error catch threw)
        // - Normal candidate exhaustion
        // - The success path cleans up early (before `return parsed`), so
        //   this final cleanup is a no-op for success.
        this._cancelledSessions.delete(session.id);
      }
    };

    // Invoke with recovery
    const attempts = await invokeWithRecovery(agentFn, recoveryOpts);

    // Find the successful result
    const lastAttempt = attempts[attempts.length - 1];
    if (lastAttempt.success && lastAttempt.result !== undefined) {
      // Mark session as done
      completeSession(this.saivageDir, session.id, 'done');
      return lastAttempt.result as T;
    }

    // All attempts failed
    completeSession(this.saivageDir, session.id, 'failed');
    throw lastAttempt.error ?? new Error(`Agent '${role}' invocation failed after ${attempts.length} attempts.`);
  }

  /**
   * Get the model router for external use.
   */
  getRouter(): ModelRouter {
    return this.router;
  }

  /**
   * Get the provider registry.
   */
  getRegistry(): ProviderRegistry {
    return this.registry;
  }

  // ── LlmCallFn Factory ───────────────────────────────────────

  /**
   * Create an LlmCallFn that uses this adapter's configured providers.
   * The returned function resolves the candidate's baseUrl and apiKey
   * from the provider registry and delegates to LlmClient.
   *
   * The provider configuration hierarchy is:
   * 1. Account-level overrides (account.baseUrl, account.apiKey)
   * 2. Provider-level defaults (provider.baseUrl, provider.apiKey)
   *
   * LlmClient instances are cached by a combined key of
   * `${baseUrl}:${apiKey}` to handle the case where two accounts
   * share the same baseUrl but use different API keys.
   */
  createLlmCallFn(): LlmCallFn {
    // Capture references so the closure doesn't rely on `this` at call time
    const registry = this.registry;
    const clientCache = this.llmClientCache;

    return async (
      candidate: Candidate,
      systemPrompt: string,
      messages: AgentMessage[],
      sessionId: string,
      opts?: LlmCompleteOptions,
    ): Promise<string> => {
      // Resolve baseUrl and apiKey from provider registry
      const provider = registry.get(candidate.provider);
      if (!provider) {
        throw new Error(
          `Provider '${candidate.provider}' not found in registry. ` +
            `Cannot resolve baseUrl/apiKey for candidate.`,
        );
      }

      // Find the account for this candidate (or implicit account)
      const account = candidate.account != null
        ? (provider.getAllAccounts().find((a) => a.name === candidate.account) ??
            provider.implicitAccount)
        : provider.implicitAccount;

      const baseUrl = account.effectiveBaseUrl(provider.baseUrl) ?? 'https://api.openai.com';
      const apiKey = account.effectiveApiKey(provider.apiKey);

      // Use a composite key that includes the apiKey so accounts sharing a
      // baseUrl with different credentials get separate cached LlmClients.
      const cacheKey = apiKey != null ? `${baseUrl}:${apiKey}` : baseUrl;

      let client = clientCache.get(cacheKey);
      if (!client) {
        client = new LlmClient(baseUrl, apiKey);
        clientCache.set(cacheKey, client);
      }

      const result = await client.complete(candidate, systemPrompt, messages, sessionId, opts);
      // The standard agent pipeline expects a plain text response for parsing.
      // Extract content; if the LLM returned tool_calls, stringify the result
      // so the calling code (planner/executor/reviewer) can still work with it.
      return result.content ?? JSON.stringify({ toolCalls: result.toolCalls });
    };
  }
}

// ── Factory ───────────────────────────────────────────────────

/**
 * Create an AgentAdapter from a project root.
 * Loads and validates config, initializes the adapter.
 */
export function createAgentAdapter(
  projectRoot: string,
  eventBus?: EventEmitter,
): AgentAdapter {
  const saivageDir = `${projectRoot}/.saivage`;
  const { config, warnings } = loadConfig(projectRoot);

  // Log warnings if any
  if (warnings.length > 0 && eventBus) {
    for (const warning of warnings) {
      eventBus.emit('config_warning', { warning });
    }
  }

  return new AgentAdapter({
    projectRoot,
    saivageDir,
    config,
    eventBus,
  });
}

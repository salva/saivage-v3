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
import { loadConfig, getRuntimeConfig, getModelParamsForRole } from './config-schema.js';
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
  getSessionMessages,
  updateSessionModel,
} from './session-persistence.js';
import type { AgentMessage } from '../schemas/types.js';
import { compactSession } from './compaction.js';
import { invokeWithRecovery, type RecoveryContext } from './recovery.js';
import type { ContentSupervisor } from '../utils/content-supervisor.js';
import { getSafeFileForAgent, type SafeFileResult } from '../utils/file-access-security.js';
import type { AgentRuntime } from './agent-runtime.js';
import { LlmClient } from './llm-client.js';
import type { LlmCompleteOptions } from './llm-client.js';
import { EventLogger } from '../utils/event-logger.js';

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

  constructor(cfg: AgentAdapterConfig) {
    this.projectRoot = cfg.projectRoot;
    this.saivageDir = cfg.saivageDir;
    this.config = cfg.config;
    this.runtimeConfig = getRuntimeConfig(cfg.config);
    this.registry = new ProviderRegistry(cfg.config);
    this.router = new ModelRouter(cfg.config, this.registry);
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

    // Resolve candidate chain
    const candidates = this.router.resolve(role);
    if (candidates.length === 0) {
      throw new Error(`No healthy candidates available for role '${role}'.`);
    }

    // Get model params (temperature, max_tokens) for this role
    const modelParams = getModelParamsForRole(this.config, role);

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
      const candidateChain = this.router.resolve(role);
      let lastError: Error | null = null;

      for (const candidate of candidateChain) {
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

          // Capture start time for duration measurement
          const callStart = Date.now();

          // Make the LLM call with role-specific temperature and max_tokens
          const rawResponse = await this.llmCallFn!(
            candidate,
            systemPrompt,
            getSessionMessages(this.saivageDir, session.id),
            session.id,
            { temperature: modelParams.temperature, max_tokens: modelParams.maxTokens },
          );

          // Compute actual call duration
          const callDuration = Date.now() - callStart;

          // Record assistant response
          appendMessage(this.saivageDir, session.id, {
            role: 'assistant',
            kind: 'text',
            content: rawResponse,
          });

          // Parse the result
          const parsed = parser(rawResponse);

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

          return parsed;
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

          // Continue to next candidate
          continue;
        }
      }

      // All candidates exhausted
      throw lastError ?? new Error(`All candidates exhausted for role '${role}'.`);
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

      return client.complete(candidate, systemPrompt, messages, sessionId, opts);
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

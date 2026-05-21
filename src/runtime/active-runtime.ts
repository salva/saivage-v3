/**
 * ActiveRuntime — Top-level integration point that creates a fully wired
 * Runtime with a real AgentAdapter (LlmCallFn configured) and shared EventLogger.
 *
 * This is the class used by the Saivage server (or other long-lived processes)
 * that want real LLM calls instead of the default FakeAgentAdapter.
 *
 * A single EventLogger and ErrorLogger instance is created and shared across
 * the Runtime and AgentAdapter, avoiding dual instances writing to the same
 * events.jsonl and errors.jsonl files.
 */

import { join } from 'node:path';
import {
  Runtime,
  type RuntimeConfig,
  type RuntimeStatus,
} from './runtime.js';
import { AgentAdapter } from '../agents/agent-adapter.js';
import { EventLogger } from '../utils/event-logger.js';
import { ErrorLogger } from '../utils/error-logger.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import {
  loadConfig,
  type SaivageConfig,
} from '../agents/config-schema.js';
import type { McpManager } from '../mcp/mcp-manager.js';
import type { RuntimeState, FreezeManifest } from '../schemas/types.js';

// ── ActiveRuntime ──────────────────────────────────────────────

export class ActiveRuntime {
  private _runtime: Runtime;
  private _agentAdapter: AgentAdapter;
  private _eventLogger: EventLogger;
  private _errorLogger: ErrorLogger;
  private _skillsEngine: SkillsEngine;
  private _projectRoot: string;
  private _config: SaivageConfig;

  /**
   * @param projectRoot  Absolute path to the project root
   * @param config       Optional SaivageConfig. If not provided, loaded via loadConfig().
   *                     Falls back to a minimal config if loadConfig() fails.
   * @param mcpManager   Optional McpManager for MCP tool invocation.
   *                     Wired into AgentAdapter for agent MCP tool calls, and
   *                     receives the shared EventLogger for invocation logging.
   */
  constructor(projectRoot: string, config?: SaivageConfig, mcpManager?: McpManager) {
    this._projectRoot = projectRoot;
    const saivageDir = join(projectRoot, '.saivage');

    // Load config if not provided
    if (config) {
      this._config = config;
    } else {
      try {
        this._config = loadConfig(projectRoot).config;
      } catch {
        // Fall back to minimal config if config can't be loaded
        this._config = {} as SaivageConfig;
      }
    }

    // Create the shared EventLogger — a single instance for both Runtime
    // and AgentAdapter to avoid dual writers on the same events.jsonl file.
    this._eventLogger = new EventLogger(saivageDir);

    // Create the shared ErrorLogger — a single instance for both Runtime
    // and AgentAdapter to avoid dual writers on the same errors.jsonl file.
    this._errorLogger = new ErrorLogger(saivageDir);

    this._skillsEngine = new SkillsEngine({ projectRoot });

    // Create the AgentAdapter with config and shared EventLogger
    // (eventBus is not passed yet because the Runtime doesn't exist yet)
    this._agentAdapter = new AgentAdapter({
      projectRoot,
      saivageDir,
      config: this._config,
      eventLogger: this._eventLogger,
    });

    // Wire the real LLM calling function
    this._agentAdapter.setLlmCallFn(this._agentAdapter.createLlmCallFn());
    this._agentAdapter.setSkillsEngine(this._skillsEngine);

    // Create the Runtime with the AgentAdapter as agentRuntime implementation.
    // Pass the shared EventLogger and ErrorLogger via RuntimeConfig so Runtime
    // does not create its own. The fakeAgentConfig is required by RuntimeConfig
    // but won't be used since we pass an explicit AgentRuntime.
    const runtimeConfig: RuntimeConfig = {
      projectRoot,
      fakeAgentConfig: { mapping: {}, fixtureDir: '' },
      skillsEngine: this._skillsEngine,
      autoDispatchBacklog: false,
      continuousImprovement: this._config.runtime.continuousImprovement,
      eventLogger: this._eventLogger,
      errorLogger: this._errorLogger,
      supervisorConfig: this._config.supervisor
        ? {
            enabled: this._config.supervisor.enabled,
            intervalMs: this._config.supervisor.intervalMs,
            consecutiveStuckVerdicts: this._config.supervisor.consecutiveStuckVerdicts,
            logLines: this._config.supervisor.logLines,
          }
        : undefined,
    };

    this._runtime = new Runtime(runtimeConfig, this._agentAdapter);

    // Wire the Runtime EventEmitter as the AgentAdapter's event bus
    // so agent events (session_started, model_selected, etc.) propagate
    // through the Runtime's EventEmitter to WebSocket clients.
    this._agentAdapter.setEventBus(this._runtime);

    // Wire McpManager into AgentAdapter's callMcpTool
    if (mcpManager) {
      this._agentAdapter.setMcpManager(mcpManager);
    }

    // Wire EventLogger into McpManager for MCP tool invocation logging
    if (mcpManager) {
      mcpManager.setEventLogger(this._eventLogger);
    }
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Start the runtime: performs startup sequence (state init, lock, crash recovery). */
  async start(): Promise<void> {
    await this._runtime.startup();
  }

  /** Stop the runtime gracefully: shutdown, release lock, cleanup, close event and error loggers. */
  async stop(): Promise<void> {
    await this._runtime.shutdown();
    // Close the shared event logger after the runtime shutdown has completed.
    // Runtime.shutdown() skips calling close() on shared EventLoggers since
    // lifecycle management is the owner's responsibility (us).
    this._eventLogger.close();
    // Same for the shared error logger.
    this._errorLogger.close();
  }

  // ── Dispatch ─────────────────────────────────────────────────

  /** Dispatch a goal through the runtime with the real AgentAdapter. */
  async dispatchGoal(goalId: string): Promise<void> {
    await this._runtime.dispatchGoal(goalId);
  }

  async requestProjectDirectiveWakeup(reason: 'lets_dance' | 'project_needs_corrections' = 'lets_dance'): Promise<{ accepted: boolean; reason: string }> {
    return this._runtime.requestProjectDirectiveWakeup(reason);
  }

  // ── Pause / Resume ───────────────────────────────────────────

  /** Pause the runtime: blocks new dispatch but does not kill running processes. */
  pause(): void {
    this._runtime.pause();
  }

  /** Resume the runtime: restores dispatch from current queue position. */
  resume(): void {
    this._runtime.resume();
  }

  // ── Freeze / Resume from Freeze ──────────────────────────────

  /** Freeze the runtime: stops dispatch and persists a freeze manifest. */
  freeze(reason?: string): FreezeManifest {
    return this._runtime.freeze(reason);
  }

  /** Resume from a saved freeze manifest. */
  resumeFromFreeze(): { freeze_id: string; restored_queue: string[]; restored_processes: string[]; restored_card_id: string | null } {
    return this._runtime.resumeFromFreeze();
  }

  /** Check if the runtime is currently frozen. */
  get isFrozen(): boolean {
    return this._runtime.status === 'frozen';
  }

  // ── Status ───────────────────────────────────────────────────

  /**
   * Get current runtime status information.
   * Returns status, paused state, current card ID, and goal count.
   */
  getStatus(): {
    status: RuntimeStatus;
    paused: boolean;
    currentCardId: string | null;
    goalCount: number;
  } {
    const state: RuntimeState | null = this._runtime.getState();
    const allCards = this._runtime.cardStore.list();
    const goalCount = allCards.filter((c) => c.type === 'goal').length;

    return {
      status: this._runtime.status,
      paused: this._runtime.paused,
      currentCardId: state?.current_card_id ?? null,
      goalCount,
    };
  }

  // ── Accessors ────────────────────────────────────────────────

  /** Returns the underlying Runtime instance. */
  get runtime(): Runtime {
    return this._runtime;
  }

  /** Returns the shared EventLogger. */
  get eventLogger(): EventLogger {
    return this._eventLogger;
  }

  /** Returns the shared ErrorLogger. */
  get errorLogger(): ErrorLogger {
    return this._errorLogger;
  }

  /** Returns the AgentAdapter with the wired LlmCallFn. */
  get agentAdapter(): AgentAdapter {
    return this._agentAdapter;
  }

  /** Returns the shared SkillsEngine used by Runtime and AgentAdapter. */
  get skillsEngine(): SkillsEngine {
    return this._skillsEngine;
  }
}

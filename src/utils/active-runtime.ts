/**
 * ActiveRuntime — Top-level integration point that creates a fully wired
 * Runtime with a real AgentAdapter (LlmCallFn configured) and shared EventLogger.
 *
 * This is the class used by the Saivage server (or other long-lived processes)
 * that want real LLM calls instead of the default FakeAgentAdapter.
 */

import { join } from 'node:path';
import {
  Runtime,
  type RuntimeConfig,
  type RuntimeStatus,
} from './runtime.js';
import { AgentAdapter } from '../agents/agent-adapter.js';
import { EventLogger } from './event-logger.js';
import {
  loadConfig,
  type SaivageConfig,
} from '../agents/config-schema.js';
import type { RuntimeState } from '../schemas/types.js';

// ── ActiveRuntime ──────────────────────────────────────────────

export class ActiveRuntime {
  private _runtime: Runtime;
  private _agentAdapter: AgentAdapter;
  private _eventLogger: EventLogger;
  private _projectRoot: string;
  private _config: SaivageConfig;

  /**
   * @param projectRoot  Absolute path to the project root
   * @param config       Optional SaivageConfig. If not provided, loaded via loadConfig().
   *                     Falls back to a minimal config if loadConfig() fails.
   */
  constructor(projectRoot: string, config?: SaivageConfig) {
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

    // Create the shared EventLogger
    this._eventLogger = new EventLogger(saivageDir);

    // Create the AgentAdapter with config and shared EventLogger
    this._agentAdapter = new AgentAdapter({
      projectRoot,
      saivageDir,
      config: this._config,
      eventLogger: this._eventLogger,
    });

    // Wire the real LLM calling function
    this._agentAdapter.setLlmCallFn(this._agentAdapter.createLlmCallFn());

    // Create the Runtime with the AgentAdapter as agentRuntime implementation.
    // The fakeAgentConfig is required by RuntimeConfig but won't be used
    // since we pass an explicit AgentRuntime.
    const runtimeConfig: RuntimeConfig = {
      projectRoot,
      fakeAgentConfig: { mapping: {}, fixtureDir: '' },
    };

    this._runtime = new Runtime(runtimeConfig, this._agentAdapter);
  }

  // ── Lifecycle ────────────────────────────────────────────────

  /** Start the runtime: performs startup sequence (state init, lock, crash recovery). */
  async start(): Promise<void> {
    await this._runtime.startup();
  }

  /** Stop the runtime gracefully: shutdown, release lock, cleanup, close event logger. */
  async stop(): Promise<void> {
    await this._runtime.shutdown();
    // Close the shared event logger after runtime shutdown (which already closes its own)
    this._eventLogger.close();
  }

  // ── Dispatch ─────────────────────────────────────────────────

  /** Dispatch a goal through the runtime with the real AgentAdapter. */
  async dispatchGoal(goalId: string): Promise<void> {
    await this._runtime.dispatchGoal(goalId);
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

  /** Returns the AgentAdapter with the wired LlmCallFn. */
  get agentAdapter(): AgentAdapter {
    return this._agentAdapter;
  }
}

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
import { EventLogger } from '../observability/index.js';
import { ErrorLogger } from '../observability/index.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import type { SaivageConfig } from '../agents/config-schema.js';
import type { McpManager } from '../mcp/manager-api.js';
import type { RuntimeState, FreezeManifest, AgentMessage } from '../schemas/index.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from './state.js';

// ── ActiveRuntime ──────────────────────────────────────────────

export interface RoundStamp { round_id: string; message_index: number; block_index: number; }
export interface PendingCall { id: string; tool: string; started_at: string; }
export type ActivityStatus = 'idle' | 'thinking' | 'tool_calling' | 'responding' | 'compacting';
export interface SessionActivity { status: ActivityStatus; pending_calls: PendingCall[]; updated_at: string; }
export interface SessionRoundState { nextRound: number; currentRoundId: string | null; nextMessageIndex: number; nextBlockIndex: number; compactedCount: number; activity: SessionActivity; }

function emptyActivity(): SessionActivity { return { status: 'idle', pending_calls: [], updated_at: new Date().toISOString() }; }

export class ActiveRuntime {
  private _runtime: Runtime;
  private _agentAdapter: AgentAdapter;
  private _eventLogger: EventLogger;
  private _errorLogger: ErrorLogger;
  private _skillsEngine: SkillsEngine;
  private _projectRoot: string;
  private _config: SaivageConfig;
  private _mcpManager?: McpManager;
  private _roundStates = new Map<string, SessionRoundState>();

  /**
   * @param projectRoot  Absolute path to the project root
   * @param config       Validated SaivageConfig from the startup Environment.
   * @param mcpManager   Optional McpManager for MCP tool invocation.
   *                     Wired into AgentAdapter for agent MCP tool calls, and
   *                     receives the shared EventLogger for invocation logging.
   */
  constructor(projectRoot: string, config?: SaivageConfig, mcpManager?: McpManager) {
    this._projectRoot = projectRoot;
    const saivageDir = join(projectRoot, '.saivage');

    if (!config) {
      throw new Error('ActiveRuntime requires validated SaivageConfig from Environment.');
    }
    this._config = config;

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
      activationLedger: {
        readState: () => readRuntimeState(projectRoot),
        appendRun: (input) => appendRuntimeRun(projectRoot, input),
        upsertActivation: (input) => upsertRuntimeActivation(projectRoot, input),
      },
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
      activeRuntime: this,
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
    this._agentAdapter.setRuntimeLedgerEventBus(this._runtime.eventBus);

    if (mcpManager) {
      this.setMcpManager(mcpManager);
    }
  }


  setMcpManager(mcpManager: McpManager): void {
    this._mcpManager = mcpManager;
    this._agentAdapter.setMcpManager(mcpManager);
    mcpManager.setEventLogger(this._eventLogger);
  }



  private getRoundState(sessionId: string): SessionRoundState {
    let state = this._roundStates.get(sessionId);
    if (!state) {
      state = { nextRound: 1, currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0, compactedCount: 0, activity: emptyActivity() };
      this._roundStates.set(sessionId, state);
    }
    return state;
  }

  openAssistantRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = `r-assistant-${state.nextRound++}`;
    state.nextMessageIndex = 0;
    state.nextBlockIndex = 0;
    this.setActivityStatus(sessionId, 'thinking');
    return this.stampInRound(sessionId);
  }

  stampInRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    if (!state.currentRoundId) state.currentRoundId = `r-assistant-${state.nextRound++}`;
    return { round_id: state.currentRoundId, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
  }

  stampUserMessage(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = null;
    state.nextBlockIndex = 0;
    return { round_id: `r-user-${state.nextRound++}`, message_index: 0, block_index: 0 };
  }

  stampPre(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    return { round_id: `r-pre-${state.nextRound++}`, message_index: 0, block_index: 0 };
  }

  stampCompacted(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    state.compactedCount += 1;
    state.currentRoundId = null;
    return { round_id: `r-compacted-${state.compactedCount}`, message_index: 0, block_index: 0 };
  }

  stampDiagnosticInCurrentRound(sessionId: string): RoundStamp {
    const state = this.getRoundState(sessionId);
    const round_id = state.currentRoundId ?? `r-diagnostic-${state.nextRound++}`;
    return { round_id, message_index: state.nextMessageIndex++, block_index: state.nextBlockIndex++ };
  }

  closeRound(sessionId: string): void {
    const state = this.getRoundState(sessionId);
    state.currentRoundId = null;
    state.nextBlockIndex = 0;
    this.setActivityStatus(sessionId, 'idle');
  }

  rebuildSessionRoundState(sessionId: string, messages: AgentMessage[] = []): SessionRoundState {
    let maxRound = 0;
    let compactedCount = 0;
    for (const message of messages) {
      const match = /r-(?:pre|user|assistant|diagnostic)-(\d+)/.exec(message.round_id);
      if (match) maxRound = Math.max(maxRound, Number(match[1]));
      const compact = /r-compacted-(\d+)/.exec(message.round_id);
      if (compact) compactedCount = Math.max(compactedCount, Number(compact[1]));
    }
    const state: SessionRoundState = { nextRound: maxRound + 1, currentRoundId: null, nextMessageIndex: 0, nextBlockIndex: 0, compactedCount, activity: emptyActivity() };
    this._roundStates.set(sessionId, state);
    return state;
  }

  getActivityStatus(sessionId: string): SessionActivity {
    return this.getRoundState(sessionId).activity;
  }

  private setActivityStatus(sessionId: string, status: ActivityStatus): void {
    const state = this.getRoundState(sessionId);
    state.activity = { ...state.activity, status, updated_at: new Date().toISOString() };
  }

  recordAppend(message: AgentMessage): void {
    const state = this.getRoundState(message.session_id);
    if (message.kind === 'tool_call' && message.tool_call_id) {
      state.activity = { status: 'tool_calling', pending_calls: [...state.activity.pending_calls, { id: message.tool_call_id, tool: message.tool ?? 'tool', started_at: message.timestamp }], updated_at: new Date().toISOString() };
    } else if ((message.kind === 'tool_result' || message.kind === 'tool_error') && message.tool_call_id) {
      state.activity = { status: 'responding', pending_calls: state.activity.pending_calls.filter((call) => call.id !== message.tool_call_id), updated_at: new Date().toISOString() };
    } else if (message.kind === 'text' && message.role === 'assistant') {
      state.activity = { ...state.activity, status: 'responding', updated_at: new Date().toISOString() };
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


  async startProject(): Promise<Awaited<ReturnType<Runtime['startProject']>>> {
    return this._runtime.startProject('operator');
  }

  async start_project(): Promise<Awaited<ReturnType<Runtime['startProject']>>> {
    return this.startProject();
  }

  async stopProject(): Promise<Awaited<ReturnType<Runtime['stopProject']>>> {
    return this._runtime.stopProject('operator');
  }

  async stop_project(): Promise<Awaited<ReturnType<Runtime['stopProject']>>> {
    return this.stopProject();
  }

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
    lastTickAt: string | null;
  } {
    const state: RuntimeState | null = this._runtime.getState();
    const allCards = this._runtime.cardStore.list();
    const goalCount = allCards.filter((c) => c.type === 'goal').length;

    return {
      status: this._runtime.status,
      paused: this._runtime.paused,
      currentCardId: state?.current_card_id ?? null,
      goalCount,
      lastTickAt: state?.last_tick_at ?? null,
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

  get mcpManager(): McpManager | undefined {
    return this._mcpManager;
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

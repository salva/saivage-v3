import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import type {
  FreezeManifest,
  CardRecord,
  RuntimeState,
  RuntimeStatus as RStatus,
  EventKind,
  LoggedEvent,
  HandoffSummary,
  FreezeProcessEntry,
} from '../schemas/types.js';
import { CardStore } from './card-store.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
} from './runtime-state.js';
import {
  saveFreezeManifest,
  readFreezeManifest,
  clearFreezeManifest,
} from './freeze-manifest.js';
import { acquireLock, releaseLock } from './runtime-lock.js';
import { FakeAgentAdapter, type FakeAgentConfig } from './fake-agent.js';
import type { AgentRuntime } from '../agents/agent-runtime.js';
import type { PlannerResult } from '../agents/result-parser.js';
import {
  buildPlannerPrompt,
  buildExecutorPrompt,
  buildReviewerPrompt,
} from '../agents/system-prompt.js';
import { SkillsEngine } from '../agents/skills-engine.js';
import {
  killAllRunning,
  listProcesses,
  type ProcessListFilter,
} from './process-runner.js';
import { cleanAll, cleanStaleStash, cleanStalePreviews, cleanStaleUploads } from './cleanup.js';
import { registerArtifact, registerAttachment } from './artifacts.js';
import type { ProcessRecord } from '../schemas/types.js';
import { EventLogger } from './event-logger.js';
import { ErrorLogger } from './error-logger.js';
import { EventBus } from './event-bus.js';
import {
  StuckAgentSupervisor,
  DEFAULT_SUPERVISOR_CONFIG,
  type SupervisorConfig,
  type SupervisorDeps,
} from './stuck-agent-supervisor.js';

// ── Types ─────────────────────────────────────────────────────

export type RuntimeStatus = RStatus;

export interface RuntimeConfig {
  projectRoot: string;
  /**
   * Configuration for the FakeAgentAdapter.
   * Only used when no explicit AgentRuntime is injected via the constructor.
   * When an agentRuntime is passed, this field is ignored.
   */
  fakeAgentConfig: FakeAgentConfig;
  /** Optional SkillsEngine for injecting matched skills into agent prompts */
  skillsEngine?: SkillsEngine;
  /** Optional EventLogger — when provided, the Runtime uses this shared instance
   *  instead of creating its own. This avoids dual instances writing to the same
   *  events.jsonl file when an ActiveRuntime already created one. */
  eventLogger?: EventLogger;
  /** Optional ErrorLogger — when provided, the Runtime uses this shared instance
   *  instead of creating its own. This avoids dual instances writing to the same
   *  errors.jsonl file when an ActiveRuntime already created one. */
  errorLogger?: ErrorLogger;
  /** Optional maximum goal depth (default: 5). When set, overrides the CardStore default. */
  maxGoalDepth?: number;
  /** Optional StuckAgentSupervisor configuration. Default: enabled with defaults. */
  supervisorConfig?: SupervisorConfig;
  /**
   * Enable continuous improvement mode: when all top-level goals are terminal
   * and the system is idle, the runtime auto-invokes the project planner with
   * an improvement directive to propose new goals. Default: false.
   */
  continuousImprovement?: boolean;
}

// ── Helpers ───────────────────────────────────────────────────

const TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'architecture',
  'code',
  'test',
  'doc',
  'data',
  'research',
  'ops',
]);

/** Card statuses that are considered terminal (no further work expected). */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled']);

function isTerminal(card: CardRecord): boolean {
  return TERMINAL_TYPES.has(card.type);
}

/**
 * Build a sorted queue of ready cards within a goal.
 * A card is "ready" if all its depends_on are satisfied
 * (those cards are in status 'done') and the card itself
 * is in 'backlog' or 'active' status.
 *
 * Sort order: depends_on resolved first (fewer dependencies first),
 * then priority (lower number = higher priority), then status.
 */
function buildReadyQueue(cards: CardRecord[]): CardRecord[] {
  return cards
    .filter((c) => {
      if (c.status !== 'backlog' && c.status !== 'active') return false;
      if (c.depends_on.length === 0) return true;
      // All dependencies must be done
      return c.depends_on.every((depId) => {
        const dep = cards.find((cc) => cc.id === depId);
        return dep && dep.status === 'done';
      });
    })
    .sort((a, b) => {
      // depends_on resolved first (fewer or no deps = earlier)
      if (a.depends_on.length !== b.depends_on.length) {
        return a.depends_on.length - b.depends_on.length;
      }
      // Priority: lower number = higher priority
      if (a.priority !== b.priority) {
        return a.priority - b.priority;
      }
      // Status (backlog comes before active for re-dispatch)
      if (a.status !== b.status) {
        return a.status === 'backlog' ? -1 : 1;
      }
      return 0;
    });
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Build the improvement directive string that tells the project planner
 * to review completed goals and propose new ones.
 *
 * @param completedGoals - List of top-level goal cards that have reached terminal states.
 */
function buildImprovementDirective(completedGoals: CardRecord[]): string {
  const goalSummaries = completedGoals
    .map(
      (g) =>
        `- **${g.title}** (${g.id}): ${g.description || 'No description'}
` +
        `  Status: ${g.status}
` +
        `  Acceptance: ${g.acceptance || 'Not specified'}`,
    )
    .join('\n');

  return [
    '## Continuous Improvement Directive',
    '',
    'This is an automated improvement invocation. All current top-level goals have reached',
    'terminal states (done, failed, or cancelled). The system is idle.',
    '',
    '### Completed Goals',
    '',
    goalSummaries,
    '',
    '### Instructions',
    '',
    '1. Review the completed goals above.',
    '2. Consider what improvements, new features, or bug fixes could enhance the project.',
    '3. Propose new goal cards for any worthwhile improvements you identify.',
    '4. You may also create cards to revisit failed goals with a revised approach.',
    '5. If no improvements are warranted, set declare_done to true to stay idle.',
    '6. Be incremental — propose 1-3 goals at most per invocation.',
    '',
    'This is a depth-0 (project-level) planning session. The system will invoke this',
    'improvement cycle again after all proposed goals complete.',
  ].join('\n');
}

function saivageWorkDir(projectRoot: string): string {
  return join(projectRoot, '.saivage-work');
}

/** Return the path to the events.jsonl file for a given project root. */
function eventsLogPath(projectRoot: string): string {
  return join(projectRoot, '.saivage', 'runtime', 'events.jsonl');
}

/**
 * Runtime event kinds that are forwarded to the EventBus.
 *
 * Only events with these names (passed to `this.emit(name, data)`) are
 * forwarded. Unknown event names are ignored by the EventBus bridge.
 */
const TRACKED_EVENT_KINDS: ReadonlySet<string> = new Set([
  'started',
  'shutdown',
  'paused',
  'resumed',
  'frozen',
  'resumed_from_freeze',
  'goal_completed',
  'goal_failed',
  'escalation',
  'card_failed',
  'review_complete',
  'review_failed',
  'plan_updated',
  'error',
  'dispatch_blocked',
  'dispatch_interrupted',
  'session_started',
  'model_selected',
  'invocation_succeeded',
  'invocation_failed',
  'retry_attempted',
  'compaction_triggered',
  'self_check_triggered',
  'stuck_supervisor_started',
  'stuck_supervisor_stopped',
  'stuck_verdict',
  'abort_target_selected',
  'force_cancel_sent',
  'session_cancelled',
  'session_force_cancelled',
  'improvement_invoked',
]);

// ── Runtime Class ────────────────────────────────────────────

export class Runtime extends EventEmitter {
  readonly projectRoot: string;
  readonly cardStore: CardStore;
  readonly agentRuntime: AgentRuntime;

  /**
   * EventBus for subscription-based event distribution.
   *
   * All tracked runtime events (via `this.emit(eventName, data)`) are
   * automatically forwarded to this EventBus as `LoggedEvent` objects.
   *
   * Consumers (e.g. WebSocket broadcast) should subscribe to this EventBus
   * instead of using `runtime.on()` for structured event distribution.
   */
  readonly eventBus: EventBus;

  private _status: RuntimeStatus = 'idle';
  private _paused: boolean = false;
  private _running: boolean = false;
  private _shuttingDown: boolean = false;

  /** Optional SkillsEngine for skill-matched prompt injection */
  private _skillsEngine: SkillsEngine | null = null;

  /** Persistent event logger for all runtime events */
  private _eventLogger: EventLogger;

  /**
   * Whether this Runtime created the EventLogger (and owns its lifecycle).
   * When false, the EventLogger was injected via RuntimeConfig and the
   * owner (e.g. ActiveRuntime) is responsible for calling close().
   */
  private _ownsEventLogger: boolean;

  /** Persistent error logger for all runtime error events */
  private _errorLogger: ErrorLogger;

  /**
   * Whether this Runtime created the ErrorLogger (and owns its lifecycle).
   * When false, the ErrorLogger was injected via RuntimeConfig and the
   * owner (e.g. ActiveRuntime) is responsible for calling close().
   */
  private _ownsErrorLogger: boolean;

  /**
   * Set of currently known running process IDs.
   * Updated on process start, exit, kill, and on crash recovery.
   */
  readonly runningProcesses: Set<string> = new Set();

  /** Stuck-agent supervisor instance */
  private _supervisor: StuckAgentSupervisor;

  /**
   * When true, the runtime may invoke the depth-0 project planner with an
   * improvement directive when all top-level goals are terminal.
   */
  private _continuousImprovement: boolean;

  /**
   * Guard to prevent concurrent improvement dispatches.
   */
  private _improvementDispatchInProgress: boolean = false;

  /**
   * @param config       Runtime configuration (projectRoot, fakeAgentConfig, etc.)
   * @param agentRuntime Optional AgentRuntime implementation.
   *                     If not provided, a FakeAgentAdapter is created internally
   *                     from config.fakeAgentConfig (backward compatibility).
   */
  constructor(config: RuntimeConfig, agentRuntime?: AgentRuntime) {
    super();
    this.projectRoot = config.projectRoot;
    this.cardStore = new CardStore(config.projectRoot, config.maxGoalDepth);
    this.agentRuntime = agentRuntime ?? new FakeAgentAdapter(config.fakeAgentConfig);
    this._skillsEngine = config.skillsEngine ?? new SkillsEngine({ projectRoot: config.projectRoot });
    this.eventBus = new EventBus();
    this._continuousImprovement = config.continuousImprovement ?? false;

    if (config.eventLogger) {
      this._eventLogger = config.eventLogger;
      this._ownsEventLogger = false;
    } else {
      this._eventLogger = new EventLogger(join(config.projectRoot, '.saivage'));
      this._ownsEventLogger = true;
    }

    if (config.errorLogger) {
      this._errorLogger = config.errorLogger;
      this._ownsErrorLogger = false;
    } else {
      this._errorLogger = new ErrorLogger(join(config.projectRoot, '.saivage'));
      this._ownsErrorLogger = true;
    }

    // ── Stuck-Agent Supervisor ───────────────────────────────

    // Build supervisor dependencies wired to Runtime internals
    const supervisorDeps: SupervisorDeps = {
      getRecentLogs: (maxLines: number) => {
        // Read recent log lines directly from the events.jsonl file.
        // EventLogger doesn't expose a convenience method for tailing,
        // so we read the file directly.
        try {
          const logPath = eventsLogPath(this.projectRoot);
          if (!existsSync(logPath)) return '';
          const raw = readFileSync(logPath, 'utf-8');
          const allLines = raw.split('\n').filter(Boolean);
          const recent = allLines.slice(-maxLines);
          return recent.join('\n');
        } catch {
          return '';
        }
      },
      getActiveSessions: () => {
        // Get active sessions from runtime state
        try {
          const state = readRuntimeState(this.projectRoot);
          if (state && state.current_agent_session_id) {
            // Derive the role from the session ID prefix convention
            // (e.g. "planner-goalId-iter", "executor-cardId-goalId-iter")
            const sessionId = state.current_agent_session_id;
            let role = 'executor';
            if (sessionId.startsWith('planner-')) {
              role = 'planner';
            } else if (sessionId.startsWith('reviewer-')) {
              role = 'reviewer';
            }
            return [{ role, sessionId }];
          }
        } catch {
          // ignore
        }
        return [];
      },
      abortSession: (sessionId: string) => {
        this.agentRuntime.cancelSession(sessionId);
      },
      forceCancelSession: (sessionId: string) => {
        this.agentRuntime.forceCancelSession(sessionId);
      },
      emitEvent: (kind: string, data: Record<string, unknown>) => {
        this.emit(kind, data);
        // Also log to EventLogger for persistence
        this._eventLogger.appendEvent({
          kind: kind as never,
          ...data,
        } as never);
      },
      isShuttingDown: () => this._shuttingDown,
    };

    const mergedSupervisorConfig: SupervisorConfig = {
      ...DEFAULT_SUPERVISOR_CONFIG,
      ...config.supervisorConfig,
    };

    this._supervisor = new StuckAgentSupervisor(mergedSupervisorConfig, supervisorDeps);
  }

  get status(): RuntimeStatus {
    return this._status;
  }

  get paused(): boolean {
    return this._paused;
  }

  get eventLogger(): EventLogger {
    return this._eventLogger;
  }

  get errorLogger(): ErrorLogger {
    return this._errorLogger;
  }

  /** Stuck-agent supervisor instance */
  get supervisor(): StuckAgentSupervisor {
    return this._supervisor;
  }

  // ── EventEmitter.emit() Override ──────────────────────────

  /**
   * Override EventEmitter.emit() to forward tracked runtime events
   * to the EventBus as LoggedEvent objects.
   *
   * The original EventEmitter behavior is preserved (all existing
   * `runtime.on(eventName, handler)` listeners continue to work).
   *
   * Forwarding logic:
   * - Only events whose name is in `TRACKED_EVENT_KINDS` are forwarded.
   * - The first argument (if it's an object) is spread into the LoggedEvent.
   * - If the first argument is not an object, it's wrapped as `{ raw: arg }`.
   *
   * @param eventName  The event name (e.g. 'goal_completed', 'error').
   * @param args       Event payload(s) — forwarded to both super.emit() and EventBus.
   */
  emit(eventName: string, ...args: unknown[]): boolean {
    // Call the original EventEmitter.emit() for backward compatibility
    const emitted = super.emit(eventName, ...args);

    // Forward to EventBus for tracked event kinds
    if (TRACKED_EVENT_KINDS.has(eventName)) {
      const data = args[0] && typeof args[0] === 'object'
        ? (args[0] as Record<string, unknown>)
        : { raw: args[0] };

      this.eventBus.emit({
        id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        kind: eventName as EventKind,
        timestamp: new Date().toISOString(),
        ...data,
      } as unknown as LoggedEvent);
    }

    return emitted;
  }

  // ── Process Lifecycle Tracking ─────────────────────────────

  /**
   * Track a new running process. Call after startProcess().
   * Updates the in-memory set and persists to RuntimeState.
   */
  trackProcessStarted(procId: string): void {
    this.runningProcesses.add(procId);
    this._syncRunningProcesses();
  }

  /**
   * Stop tracking a process (exited, failed, killed). Call after
   * the process reaches a terminal state.
   * Updates the in-memory set and persists to RuntimeState.
   */
  trackProcessStopped(procId: string): void {
    this.runningProcesses.delete(procId);
    this._syncRunningProcesses();
  }

  /**
   * List currently tracked running processes via the process registry.
   */
  listRunningProcesses(filter?: ProcessListFilter): ProcessRecord[] {
    return listProcesses(this.projectRoot, {
      ...filter,
      status: 'running',
    });
  }

  /**
   * Persist the current running_processes list to RuntimeState.
   */
  private _syncRunningProcesses(): void {
    try {
      updateRuntimeState(this.projectRoot, {
        running_processes: Array.from(this.runningProcesses),
      });
    } catch {
      // Best effort — state file may not exist yet during early startup
    }
  }

  // ── Artifact / Attachment Registration ─────────────────────

  /**
   * Register an artifact on a card. Convenience wrapper around
   * the standalone registerArtifact function.
   */
  registerArtifactOnCard(
    cardId: string,
    artifact: {
      type: 'model' | 'data' | 'config' | 'log' | 'report' | 'other';
      description: string;
      retain: boolean;
    },
    sourceFile: string,
  ) {
    return registerArtifact(
      saivageWorkDir(this.projectRoot),
      this.cardStore,
      cardId,
      artifact,
      sourceFile,
    );
  }

  /**
   * Register an attachment on a card. Convenience wrapper.
   */
  registerAttachmentOnCard(
    cardId: string,
    attachment: { mime: string; title: string; description?: string },
    sourceFile: string,
  ) {
    return registerAttachment(
      saivageWorkDir(this.projectRoot),
      this.cardStore,
      cardId,
      attachment,
      sourceFile,
    );
  }

  // ── Startup ───────────────────────────────────────────────

  /**
   * Startup sequence:
   * 1. Discover project (already known via projectRoot)
   * 2. Init/load runtime state
   * 3. Acquire runtime lock
   * 4. Crash recovery (reset active/running cards to backlog)
   * 5. Recover running_processes from saved state
   * 6. Write initial runtime state
   * 7. Start stuck-agent supervisor
   */
  async startup(): Promise<void> {
    if (this._running) {
      throw new Error('Runtime is already running.');
    }

    // 1. Ensure runtime state file exists
    let state = readRuntimeState(this.projectRoot);
    if (!state) {
      state = initRuntimeState(this.projectRoot);
    }

    // 2. Acquire lock
    acquireLock(this.projectRoot);

    // 3. Crash recovery
    this.performCrashRecovery();

    // 4. Recover running_processes from saved state
    //    (process output files survive, but actual PIDs are dead after crash)
    if (state.running_processes && state.running_processes.length > 0) {
      // On crash recovery, previously running processes are orphaned.
      // We preserve their IDs in the running set for tracking purposes
      // (the process-runner registry still has their records — they'll show
      // as running until the operator/cleanup resolves them).
      // But we don't auto-kill them here — they already died with the runtime.
      // We simply clear them from the live tracking set since the OS processes are gone.
      this.runningProcesses.clear();
      this._syncRunningProcesses();
    }

    // 5. Write initial state
    state = initRuntimeState(this.projectRoot);
    this._status = 'idle';
    this._paused = false;
    this._running = true;
    this._shuttingDown = false;

    this.emit('started', { projectRoot: this.projectRoot });
    this._eventLogger.appendEvent({
      kind: 'started',
      project_root: this.projectRoot,
    });

    // 6. Start stuck-agent supervisor
    this._supervisor.start();

    // 7. After startup, if continuous improvement is enabled,
    //    check if we should invoke the improvement planner immediately.
    void this._checkContinuousImprovement();
  }

  // ── Shutdown ──────────────────────────────────────────────

  /**
   * Graceful shutdown:
   * 1. Stop stuck-agent supervisor
   * 2. Freeze tracker (stop new dispatch)
   * 3. Kill orphan running processes
   * 4. Write shutdown state (idle)
   * 5. Release lock
   * 6. Run safe cleanup
   */
  async shutdown(): Promise<void> {
    if (!this._running) return;

    // When frozen, release lock and skip cleanup — the freeze manifest
    // preserves state for resume after upgrade.
    if (this._status === 'frozen') {
      try { releaseLock(this.projectRoot); } catch { /* best effort */ }
      this._running = false;
      this._shuttingDown = false;
      this._status = 'idle';
      this.emit('shutdown');
      this._eventLogger.appendEvent({ kind: 'shutdown' });
      if (this._ownsEventLogger) {
        this._eventLogger.close();
      }
      if (this._ownsErrorLogger) {
        this._errorLogger.close();
      }
      return;
    }

    this._shuttingDown = true;
    this._running = false;

    // 1. Stop stuck-agent supervisor first (before killing processes)
    this._supervisor.stop();

    // 2. Kill orphan processes
    try {
      const killedIds = await killAllRunning(this.projectRoot);
      for (const id of killedIds) {
        this.runningProcesses.delete(id);
      }
    } catch {
      // Best effort
    }

    // 3. Write final idle state
    try {
      saveRuntimeState(this.projectRoot, {
        status: 'idle',
        project_id: 'project',
        pid: process.pid,
        started_at: now(),
        current_card_id: null,
        current_agent_session_id: null,
        paused: false,
        paused_at: null,
        queue: [],
        running_processes: [],
        updated_at: now(),
      });
    } catch {
      // Best effort
    }

    // 4. Release lock
    try {
      releaseLock(this.projectRoot);
    } catch {
      // Best effort
    }

    // 5. Run safe cleanup
    try {
      cleanAll(saivageWorkDir(this.projectRoot), this.cardStore);
    } catch {
      // Best effort
    }

    this._status = 'idle';
    this.emit('shutdown');
    this._eventLogger.appendEvent({ kind: 'shutdown' });

    // Only close the EventLogger if we own it (not shared).
    // When an external EventLogger is injected, lifecycle management
    // is the owner's responsibility (e.g. ActiveRuntime).
    if (this._ownsEventLogger) {
      this._eventLogger.close();
    }

    // Same pattern for ErrorLogger
    if (this._ownsErrorLogger) {
      this._errorLogger.close();
    }
  }

  // ── Pause / Resume ────────────────────────────────────────

  /**
   * Global pause: stops new dispatch. Does not kill running processes.
   * Persists pause state to disk so it survives restart.
   */
  pause(): void {
    this._paused = true;
    try {
      updateRuntimeState(this.projectRoot, {
        status: 'paused',
        paused: true,
        paused_at: now(),
      });
    } catch {
      // best effort
    }
    this.emit('paused');
    this._eventLogger.appendEvent({ kind: 'paused' });
  }

  /**
   * Global resume: restores dispatch from current queue position.
   * Persists resume state to disk.
   */
  resume(): void {
    this._paused = false;
    try {
      updateRuntimeState(this.projectRoot, {
        status: 'idle',
        paused: false,
        paused_at: null,
      });
    } catch {
      // best effort
    }
    this.emit('resumed');
    this._eventLogger.appendEvent({ kind: 'resumed' });
  }
  // ── Freeze / Resume from Freeze ───────────────────────────

  /**
   * Freeze the runtime: stops new dispatch and persists a freeze manifest.
   *
   * The freeze captures the current runtime state so it can be resumed later.
   * Freezing while idle saves a manifest with empty state (no-op freeze).
   * Freezing while already frozen is idempotent (returns existing manifest).
   * Freezing while paused also works — it upgrades pause to freeze.
   *
   * @param reason - Optional human-readable reason for the freeze.
   * @returns The FreezeManifest that was persisted.
   */
  private buildFreezeProcessEntries(
    procIds: string[],
    defaultAction: "kill" | "reattach" | "detach" = "reattach",
  ): FreezeProcessEntry[] {
    return procIds.map((id) => ({ id, action: defaultAction }));
  }

  freeze(reason?: string,
    defaultProcessAction: "kill" | "reattach" | "detach" = "reattach",
  ): FreezeManifest {
    // If already frozen, return existing manifest (idempotent)
    if (this._status === 'frozen') {
      const existing = readFreezeManifest(this.projectRoot);
      if (existing) {
        return existing;
      }
      // Manifest was somehow missing — still proceed as a fresh freeze
    }

    // 1. Stop new dispatch by setting status to frozen
    this._status = 'frozen';
    this._paused = true; // frozen implies paused (no dispatch)

    // 2. Build freeze manifest from current state
    const state = readRuntimeState(this.projectRoot);
    const frozenAt = new Date();
    const freezeId = `freeze-${frozenAt.toISOString().replace(/[:.]/g, '-')}`;

    // Collect handoff summaries from active agent sessions
    let handoffSummaries: HandoffSummary[] = [];
    try {
      const raw = this.agentRuntime.getActiveSessionHandoffs();
      handoffSummaries = raw instanceof Promise ? [] : raw;
    } catch {
      // Best effort — handoff collection should not block freeze
    }

    // Build process entries with classification
    const processIds = state?.running_processes ?? [];
    const runningProcesses = this.buildFreezeProcessEntries(processIds, defaultProcessAction);

    const manifest: FreezeManifest = {
      freeze_id: freezeId,
      reason: reason ?? 'operator requested freeze',
      created_at: frozenAt.toISOString(),
      status: 'frozen',
      project_id: 'project',
      pid: process.pid,
      started_at: state?.started_at ?? frozenAt.toISOString(),
      current_card_id: state?.current_card_id ?? null,
      current_agent_session_id: state?.current_agent_session_id ?? null,
      queue: state?.queue ?? [],
      running_processes: runningProcesses,
      handoff_summaries: handoffSummaries,
      schema_version: 1,
      runtime_version: '0.1.0',
    };

    // 3. Persist the freeze manifest
    saveFreezeManifest(this.projectRoot, manifest);

    // 4. Persist the updated runtime state (status = frozen)
    try {
      saveRuntimeState(this.projectRoot, {
        status: 'frozen',
        project_id: 'project',
        pid: process.pid,
        started_at: state?.started_at ?? frozenAt.toISOString(),
        current_card_id: state?.current_card_id ?? null,
        current_agent_session_id: state?.current_agent_session_id ?? null,
        paused: true,
        paused_at: frozenAt.toISOString(),
        queue: state?.queue ?? [],
        running_processes: processIds,
        updated_at: frozenAt.toISOString(),
      });
    } catch {
      // Best effort
    }

    // 5. Emit freeze event (for EventBus forwarding)
    this.emit('frozen', { freeze_id: manifest.freeze_id, reason: manifest.reason });
    this._eventLogger.appendEvent({ kind: 'frozen' as never });

    return manifest;
  }

  /**
   * Resume from a saved freeze manifest.
   *
   * Reads the freeze manifest, validates compatibility, restores runtime
   * state, and clears the manifest on success.
   *
   * @returns An object describing what was restored.
   * @throws If there is no freeze manifest to resume from.
   */
  resumeFromFreeze(): { freeze_id: string; restored_queue: string[]; restored_processes: string[]; restored_card_id: string | null } {
    // 1. Check that a freeze manifest exists
    const manifest = readFreezeManifest(this.projectRoot);
    if (!manifest) {
      throw new Error('Cannot resume: no freeze manifest found. The runtime is not frozen.');
    }

    // 2. Validate compatibility
    // Check schema version compatibility (schema_version 1 is always compatible)
    if (manifest.schema_version > 1) {
      throw new Error(
        `Cannot resume: freeze manifest schema version ${manifest.schema_version} is newer ` +
        `than the supported version 1. Upgrade Saivage to resume this freeze.`
      );
    }

    // Check runtime version (allow same major version)
    const currentVersion = '0.1.0';
    if (manifest.runtime_version !== currentVersion) {
      // For now, warn but allow. In production, add a version compatibility check.
      console.warn(
        `Resuming from freeze created by runtime version ${manifest.runtime_version} ` +
        `with current version ${currentVersion}. State may differ.`
      );
    }

    // 3. Restore state from manifest
    this._status = 'idle';
    this._paused = false;

    // Extract process IDs from FreezeProcessEntry[] (discard action for in-memory tracking)
    const processIds = manifest.running_processes.map((p) => p.id);

    // Restore runtime state on disk
    try {
      saveRuntimeState(this.projectRoot, {
        status: 'idle',
        project_id: 'project',
        pid: process.pid,
        started_at: manifest.started_at,
        current_card_id: manifest.current_card_id,
        current_agent_session_id: manifest.current_agent_session_id,
        paused: false,
        paused_at: null,
        queue: manifest.queue,
        running_processes: processIds,
        updated_at: new Date().toISOString(),
      });
    } catch {
      // Best effort
    }

    // 4. Restore in-memory process tracking
    this.runningProcesses.clear();
    for (const procId of processIds) {
      this.runningProcesses.add(procId);
    }

    // 5. Inject handoff summaries into resumed agent context
    const handoffSummaries = manifest.handoff_summaries ?? [];
    if (handoffSummaries.length > 0 && manifest.current_agent_session_id) {
      const handoffText = handoffSummaries
        .map(
          (h) =>
            `[Handoff] Session: ${h.session_id}, Role: ${h.role}, ` +
            `Last action: ${h.last_action}, Next action: ${h.next_action}, ` +
            `Context: ${h.context_summary}`,
        )
        .join('\n');
      this._resumeHandoffContext = handoffText;
    }

    // 6. Clear the manifest (resume is a one-time operation)
    clearFreezeManifest(this.projectRoot);

    // 7. Emit resume event
    this.emit('resumed_from_freeze', { freeze_id: manifest.freeze_id });
    this._eventLogger.appendEvent({ kind: 'resumed_from_freeze' as never });

    return {
      freeze_id: manifest.freeze_id,
      restored_queue: manifest.queue,
      restored_processes: processIds,
      restored_card_id: manifest.current_card_id,
    };
  }


  /**
   * Handoff context text injected during resumeFromFreeze().
   * The dispatch loop passes this into the next agent invocation
   * as context messages.
   */
  private _resumeHandoffContext: string | null = null;

  /**
   * Get the resume handoff context (if any) and clear it.
   */
  consumeResumeHandoffContext(): string | null {
    const ctx = this._resumeHandoffContext;
    this._resumeHandoffContext = null;
    return ctx;
  }

  /**
   * Bridge method that forwards agent events (session_started, model_selected,
   * invocation_succeeded, invocation_failed, retry_attempted, compaction_triggered)
   * from the AgentAdapter through the Runtime's EventEmitter so they can be
   * broadcast to WebSocket clients by wireRuntimeEvents().
   *
   * This method intentionally does NOT call _eventLogger.appendEvent() because
   * the AgentAdapter already logs these agent events directly to EventLogger
   * for persistent storage. Calling it here would create duplicate entries
   * in events.jsonl.
   *
   * @param name - The agent event name (e.g. 'session_started', 'model_selected')
   * @param data - Event payload with event-specific fields
   */
  emitAgentEvent(name: string, data: Record<string, unknown>): void {
    this.emit(name, data);
  }

  // ── Crash Recovery ────────────────────────────────────────

  /**
   * Reset active/running cards to backlog, clean stale tmp files.
   */
  performCrashRecovery(): void {
    // Reset cards stuck in active/running
    const allCards = this.cardStore.list();
    for (const card of allCards) {
      if (card.status === 'active' || card.status === 'running') {
        this.cardStore.setStatus(card.id, 'backlog');
      }
    }

    // Sweep stale .tmp files from .saivage-work/tmp/runtime/ (NOT runtime.lock)
    const tmpRuntimeDir = join(this.projectRoot, '.saivage-work', 'tmp', 'runtime');
    if (existsSync(tmpRuntimeDir)) {
      try {
        const entries = readdirSync(tmpRuntimeDir);
        for (const entry of entries) {
          if (entry === 'runtime.lock') continue; // Don't touch the lock via sweep
          if (entry.endsWith('.tmp') || entry.endsWith('.tmp.') || entry.includes('.tmp.')) {
            try {
              rmSync(join(tmpRuntimeDir, entry), { recursive: true, force: true });
            } catch {
              // ignore per-file errors
            }
          }
        }
      } catch {
        // ignore broader errors
      }
    }

    // Clean stale stash files older than 24 hours
    try {
      cleanStaleStash(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000);
    } catch {
      // best effort
    }

    // Also clean stale previews/uploads
    try {
      cleanStalePreviews(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000);
    } catch {
      // best effort
    }
    try {
      cleanStaleUploads(saivageWorkDir(this.projectRoot), 24 * 60 * 60 * 1000);
    } catch {
      // best effort
    }
  }

  // ── Queue Selection ───────────────────────────────────────

  /**
   * Get ready cards sorted by dependency resolution, then priority.
   * Only returns cards within a given goal context.
   */
  getReadyQueue(goalId: string): CardRecord[] {
    const allCards = this.cardStore.list();
    // Get all descendants of the goal
    const descendantIds = new Set(this.cardStore.getDescendantIds(goalId));
    descendantIds.add(goalId); // include the goal itself

    const relevantCards = allCards.filter(
      (c) => descendantIds.has(c.id) && isTerminal(c),
    );

    return buildReadyQueue(relevantCards);
  }

  // ── Dispatch Logic ────────────────────────────────────────

  /**
   * Run the full goal flow: planner → executor → reviewer loop.
   *
   * This is the main dispatch method. It simulates the full lifecycle
   * using an AgentRuntime implementation (fake or real).
   *
   * Runtime state is persisted at key transitions so crash recovery
   * can resume from the last known point.
   *
   * @param goalId - The goal (or project) card ID to process.
   */
  async dispatchGoal(goalId: string): Promise<void> {
    if (this._paused) {
      this.emit('dispatch_blocked', { reason: 'paused', goalId });
      this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId });
      return;
    }

    // Step 1: Activate the goal and get/create the plan card
    let planCard: CardRecord;
    try {
      const result = this.cardStore.activateGoal(goalId);
      planCard = result.plan;
      // Persist: goal active, dispatch running
      updateRuntimeState(this.projectRoot, {
        status: 'running',
        current_card_id: goalId,
        queue: this.getReadyQueue(goalId).map((c) => c.id),
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emit('error', { goalId, phase: 'activate', error: err });
      this._eventLogger.appendEvent({
        kind: 'error',
        goal_id: goalId,
        phase: 'activate',
        error_message: errorMessage,
      });
      this._errorLogger.appendError({
        message: errorMessage,
        goalId,
        phase: 'activate',
      });
      return;
    }

    // Main loop: planner → executor(s) → reviewer
    let plannerDone = false;
    const MAX_ITERATIONS = 50; // safety limit to prevent infinite loops

    for (
      let iter = 0;
      iter < MAX_ITERATIONS && !plannerDone && !this._shuttingDown;
      iter++
    ) {
      if (this._paused) {
        this.emit('dispatch_blocked', { reason: 'paused', goalId });
        this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId });
        updateRuntimeState(this.projectRoot, { status: 'paused' });
        return;
      }

      // Step 2: Invoke the planner
      let plannerResult: PlannerResult;
      try {
        // Get goal card for depth context
        const goalCardForDepth = this.cardStore.read(goalId);
        const currentDepth = goalCardForDepth?.depth;
        const maxDepth = this.cardStore.maxDepth;

        // Build planner prompt with matched skills
        let plannerPrompt = buildPlannerPrompt(undefined, currentDepth, maxDepth);
        try {
          // Get the goal card for match context
          const goalCard = this.cardStore.read(goalId);
          if (goalCard && this._skillsEngine) {
            // Depth-0 planner always uses .saivage/instructions/planner.md.
            // Depth > 0 with instructions_file uses that custom path.
            // Depth > 0 without instructions_file gets empty string (no instructions).
            const plannerInstr = goalCard.depth === 0
              ? await this._skillsEngine.loadPlannerInstructions()
              : (goalCard.instructions_file && goalCard.instructions_file.trim())
                ? await this._skillsEngine.loadPlannerInstructions(goalCard.instructions_file.trim())
                : '';
            // Match skills for planner role
            const skillsContent = await this._skillsEngine.selectAndFormat({
              goalDescription: goalCard.description,
              cardDescription: goalCard.description,
              tags: goalCard.tags,
              filePaths: [],
              availableTools: ['create_card', 'edit_card', 'move_card', 'delete_card', 'add_note', 'list_cards', 'get_card', 'load_skill', 'mcp_tool_call'],
              targetRole: 'planner',
            });
            const combinedSkills = [plannerInstr, skillsContent].filter(Boolean).join('\n\n');
            if (combinedSkills) {
              plannerPrompt = buildPlannerPrompt(combinedSkills, currentDepth, maxDepth);
            }
          }
        } catch {
          // Skills engine failure should not break dispatch — use plain prompt
        }

        const result = this.agentRuntime.invokePlanner(goalId, planCard.id, plannerPrompt);
        plannerResult = result instanceof Promise ? await result : result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        this.emit('error', { goalId, phase: 'planner', error: err });
        this._eventLogger.appendEvent({
          kind: 'error',
          goal_id: goalId,
          phase: 'planner',
          error_message: errorMessage,
        });
        this._errorLogger.appendError({
          message: errorMessage,
          goalId,
          phase: 'planner',
        });
        break;
      }

      // Apply planner's card mutations
      this.applyPlannerResult(goalId, plannerResult);

      // Persist updated queue after planner mutations
      updateRuntimeState(this.projectRoot, {
        current_agent_session_id: `planner-${goalId}-${iter}`,
        queue: this.getReadyQueue(goalId).map((c) => c.id),
      });

      if (plannerResult.declare_done) {
        plannerDone = true;
      } else {
        // Step 3: Execute ready terminal cards
        await this.executeReadyCards(goalId);
      }

      if (this._shuttingDown) break;
      if (this._paused) {
        this.emit('dispatch_blocked', { reason: 'paused', goalId });
        this._eventLogger.appendEvent({ kind: 'dispatch_blocked', reason: 'paused', goal_id: goalId });
        return;
      }

      // Step 4: If planner declared done, invoke reviewer
      if (plannerDone) {
        const reviewResult = await this.invokeReviewer(goalId, planCard.id);

        if (reviewResult.assessment.result === 'pass') {
          // Goal done! Transition through running per lifecycle spec.
          this.cardStore.setStatus(goalId, 'running');
          this.cardStore.setStatus(goalId, 'done');
          // Persist final state
          updateRuntimeState(this.projectRoot, {
            status: 'idle',
            current_card_id: null,
            current_agent_session_id: null,
            queue: [],
          });
          this.emit('goal_completed', {
            goalId,
            assessment: reviewResult.assessment,
          });
          this._eventLogger.appendEvent({
            kind: 'goal_completed',
            goal_id: goalId,
            assessment: reviewResult.assessment,
          });

          // After goal completes, check continuous improvement mode
          await this._checkContinuousImprovement();
          return;
        } else {
          // Review failed — re-invoke planner
          plannerDone = false;
          this.emit('review_failed', {
            goalId,
            assessment: reviewResult.assessment,
          });
          this._eventLogger.appendEvent({
            kind: 'review_failed',
            goal_id: goalId,
            assessment: reviewResult.assessment,
          });
        }
      }
    }

    if (this._shuttingDown) {
      this.emit('dispatch_interrupted', { goalId, reason: 'shutdown' });
      this._eventLogger.appendEvent({ kind: 'dispatch_interrupted', goal_id: goalId, reason: 'shutdown' });
    }
  }

  /**
   * Execute all ready terminal cards under a goal.
   */
  private async executeReadyCards(goalId: string): Promise<void> {
    let readyCards = this.getReadyQueue(goalId);
    const goalCard = this.cardStore.read(goalId);

    while (readyCards.length > 0 && !this._shuttingDown) {
      if (this._paused) return;

      for (const card of readyCards) {
        if (this._shuttingDown || this._paused) return;

        // Transition card to running via the lifecycle state machine.
        // backlog → active → running (backlog must go through active first)
        if (card.status === 'backlog') {
          this.cardStore.setStatus(card.id, 'active');
        }
        this.cardStore.setStatus(card.id, 'running');

        // Persist current_card_id to track what's running
        updateRuntimeState(this.projectRoot, { current_card_id: card.id });

        // Invoke executor
        let execResult;
        try {
          // Build executor prompt with matched skills
          let executorPrompt = buildExecutorPrompt(card.type);
          try {
            if (this._skillsEngine) {
              const skillsContent = await this._skillsEngine.selectAndFormat({
                goalDescription: goalCard?.description ?? '',
                cardDescription: card.description,
                tags: card.tags,
                filePaths: [],
                availableTools: ['start_process', 'wait_process', 'start_and_wait', 'tail_output', 'kill_process', 'list_processes', 'download_file', 'load_skill', 'mcp_tool_call'],
                targetRole: 'executor',
              });
              if (skillsContent) {
                executorPrompt = buildExecutorPrompt(card.type, skillsContent);
              }
            }
          } catch {
            // Skills engine failure should not break dispatch
          }

          const result = this.agentRuntime.invokeExecutor(card.id, goalId, executorPrompt);
          execResult = result instanceof Promise ? await result : result;
        } catch (err) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          this.emit('error', {
            cardId: card.id,
            goalId,
            phase: 'executor',
            error: err,
          });
          this._eventLogger.appendEvent({
            kind: 'error',
            card_id: card.id,
            goal_id: goalId,
            phase: 'executor',
            error_message: errorMessage,
          });
          this._errorLogger.appendError({
            message: errorMessage,
            cardId: card.id,
            goalId,
            phase: 'executor',
          });
          this.cardStore.setStatus(card.id, 'failed');
          // Failed terminal card re-invokes parent planner
          this.emit('card_failed', { cardId: card.id, goalId });
          this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId });
          return; // stop processing siblings, planner will be re-invoked
        }

        // Apply executor result
        this.cardStore.update(card.id, {
          status: execResult.status,
          result: execResult.result ?? null,
          error: execResult.error ?? null,
        });

        // Register artifacts from executor result
        if (execResult.artifacts && execResult.artifacts.length > 0) {
          for (const artDef of execResult.artifacts) {
            try {
              this.registerArtifactOnCard(
                card.id,
                {
                  type: artDef.type,
                  description: artDef.description,
                  retain: artDef.retain,
                },
                artDef.sourceFile ?? '',
              );
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              this.emit('error', {
                cardId: card.id,
                phase: 'artifact_registration',
                error: err,
              });
              this._eventLogger.appendEvent({
                kind: 'error',
                card_id: card.id,
                phase: 'artifact_registration',
                error_message: errorMessage,
              });
              this._errorLogger.appendError({
                message: errorMessage,
                cardId: card.id,
                goalId,
                phase: 'artifact_registration',
              });
            }
          }
        }

        // Register attachments from executor result
        if (execResult.attachments && execResult.attachments.length > 0) {
          for (const attDef of execResult.attachments) {
            try {
              this.registerAttachmentOnCard(
                card.id,
                {
                  mime: attDef.mime,
                  title: attDef.title,
                  description: attDef.description,
                },
                attDef.sourceFile ?? '',
              );
            } catch (err) {
              const errorMessage = err instanceof Error ? err.message : String(err);
              this.emit('error', {
                cardId: card.id,
                phase: 'attachment_registration',
                error: err,
              });
              this._eventLogger.appendEvent({
                kind: 'error',
                card_id: card.id,
                phase: 'attachment_registration',
                error_message: errorMessage,
              });
              this._errorLogger.appendError({
                message: errorMessage,
                cardId: card.id,
                goalId,
                phase: 'attachment_registration',
              });
            }
          }
        }

        if (execResult.status === 'failed') {
          this.emit('card_failed', { cardId: card.id, goalId });
          this._eventLogger.appendEvent({ kind: 'card_failed', card_id: card.id, goal_id: goalId });
          return; // stop processing, planner will handle failure
        }
      }

      // Refresh ready queue (some cards may have been unblocked)
      readyCards = this.getReadyQueue(goalId);
    }
  }

  // ── Reviewer ──────────────────────────────────────────────

  /**
   * Invoke reviewer and record the assessment.
   * Works with both synchronous (fake) and asynchronous (real LLM)
   * AgentRuntime implementations.
   */
  async invokeReviewer(
    goalId: string,
    planCardId: string,
  ): Promise<{
    assessment: {
      result: 'pass' | 'fail';
      summary: string;
      achieved: string[];
      missing: string[];
      evidence_card_ids: string[];
    };
  }> {
    // Build reviewer prompt with matched skills
    let reviewerPrompt = buildReviewerPrompt();
    try {
      if (this._skillsEngine) {
        const skillsContent = await this._skillsEngine.selectAndFormat({
          goalDescription: '',
          cardDescription: '',
          tags: [],
          filePaths: [],
          availableTools: ['review', 'load_skill', 'mcp_tool_call'],
          targetRole: 'reviewer',
        });
        if (skillsContent) {
          reviewerPrompt = buildReviewerPrompt(skillsContent);
        }
      }
    } catch {
      // Skills engine failure should not break dispatch
    }

    const result = await this.agentRuntime.invokeReviewer(goalId, planCardId, reviewerPrompt);
    this.emit('review_complete', {
      goalId,
      assessment: result.assessment,
    });
    this._eventLogger.appendEvent({
      kind: 'review_complete',
      goal_id: goalId,
      assessment: result.assessment,
    });
    return result;
  }

  // ── Planner Result Application ────────────────────────────

  /**
   * Apply planner-requested card mutations: create cards, update cards.
   *
   * Note: cardStore.create() recomputes depth from the parent internally,
   * so the depth: 0 here is overwritten — kept only for TypeScript compatibility
   * with the Omit<CardRecord, 'created_at' | 'updated_at' | 'id'> type.
   */
  applyPlannerResult(
    goalId: string,
    plannerResult: PlannerResult,
  ): void {
    // Create new cards
    if (plannerResult.created_cards) {
      for (const cardDef of plannerResult.created_cards) {
        this.cardStore.create({
          id: cardDef.id,
          type: cardDef.type as CardRecord['type'],
          parent: goalId,
          title: cardDef.title,
          description: cardDef.description,
          status: cardDef.status as CardRecord['status'],
          depends_on: cardDef.depends_on,
          priority: cardDef.priority,
          tags: cardDef.tags ?? [],
          urgency: 'normal',
          created_by: 'planner',
          blocks: [],
          related: [],
          acceptance: '',
          artifacts: [],
          attachments: [],
          retries: 0,
          depth: 0, // overwritten by cardStore.create() — kept for TS compatibility
        });
      }
    }

    // Update existing cards
    if (plannerResult.updated_cards) {
      for (const update of plannerResult.updated_cards) {
        const changes: Partial<CardRecord> = {};
        if (update.status !== undefined)
          changes.status = update.status as CardRecord['status'];
        if (update.title !== undefined) changes.title = update.title;
        if (update.description !== undefined)
          changes.description = update.description;
        this.cardStore.update(update.id, changes);
      }
    }
  }

  // ── Simulated Crash ────────────────────────────────────────

  /**
   * Simulate a crash: set active/running cards to backlog without
   * proper shutdown. Useful for testing crash recovery.
   */
  simulateCrash(): void {
    const allCards = this.cardStore.list();
    for (const card of allCards) {
      if (card.status === 'active' || card.status === 'running') {
        this.cardStore.setStatus(card.id, 'backlog');
      }
    }
    this._running = false;
    // Note: lock is intentionally NOT released (simulates a crash)
  }

  // ── Cleanup ────────────────────────────────────────────────

  /**
   * Run safe cleanup operations. Convenience wrapper around the
   * cleanup module. Never removes retained artifacts, attachments,
   * download reviews, or quarantine metadata.
   */
  runCleanup(options?: {
    stashMaxAgeMs?: number;
    processMaxAgeMs?: number;
    previewsMaxAgeMs?: number;
    uploadsMaxAgeMs?: number;
  }) {
    return cleanAll(saivageWorkDir(this.projectRoot), this.cardStore, options);
  }

  // ── Utility ────────────────────────────────────────────────

  /**
   * Get the current runtime state as a RuntimeState object
   * (as opposed to what's on disk).
   */
  getState(): RuntimeState | null {
    return readRuntimeState(this.projectRoot);
  }

  // ── Continuous Improvement ────────────────────────────

  /**
   * After a goal completes or on startup, check if continuous improvement mode
   * is enabled and all top-level goals are terminal. If so, invoke the project
   * planner with an improvement directive to propose new goals.
   *
   * Guards:
   * - Only runs when _continuousImprovement is true
   * - Only runs when not paused and not shutting down
   * - Only runs when not already dispatching an improvement (prevents re-entry)
   * - Only runs when all top-level goals (type='goal', parent='project') are terminal
   */
  private async _checkContinuousImprovement(): Promise<void> {
    // Guard: feature must be enabled
    if (!this._continuousImprovement) return;

    // Guard: no dispatch during pause or shutdown
    if (this._paused) return;
    if (this._shuttingDown) return;

    // Guard: prevent concurrent improvement dispatches
    if (this._improvementDispatchInProgress) return;

    // Check: all top-level goals must be terminal
    const allCards = this.cardStore.list();

    // Get all goals that are direct children of 'project'
    const topLevelGoals = allCards.filter(
      (c) => c.type === 'goal' && c.parent === 'project',
    );

    // If there are no top-level goals, there's nothing to improve
    if (topLevelGoals.length === 0) return;

    // All top-level goals must be in terminal states
    const allTerminal = topLevelGoals.every((g) => TERMINAL_STATUSES.has(g.status));
    if (!allTerminal) return;

    // All guards passed — invoke the project planner
    this._improvementDispatchInProgress = true;

    try {
      // Emit event before dispatch so listeners can react
      this.emit('improvement_invoked', {
        goalIds: topLevelGoals.map((g) => g.id),
      });
      this._eventLogger.appendEvent({
        kind: 'improvement_invoked' as never,
        goal_ids: topLevelGoals.map((g) => g.id),
      });

      // Build an improvement directive for the project planner
      const improvementDirective = buildImprovementDirective(topLevelGoals);

      // Get the project card for depth context
      const projectGoal = this.cardStore.read('project');
      const currentDepth = projectGoal?.depth ?? 0;
      const maxDepth = this.cardStore.maxDepth;

      // Build planner prompt with the improvement directive
      const plannerPrompt = buildPlannerPrompt(improvementDirective, currentDepth, maxDepth);

      // Activate the project goal to get/create the plan card
      const planCardResult = this.cardStore.activateGoal('project');
      const planCardId = planCardResult.plan.id;

      // Invoke the planner using the agentRuntime
      const result = this.agentRuntime.invokePlanner('project', planCardId, plannerPrompt);
      const plannerResult = result instanceof Promise ? await result : result;

      // Apply the planner's card mutations
      this.applyPlannerResult('project', plannerResult);

      // Log the improvement dispatch
      this.emit('plan_updated', {
        goalId: 'project',
        source: 'continuous-improvement',
      });
      this._eventLogger.appendEvent({
        kind: 'plan_updated' as never,
        goal_id: 'project',
        source: 'continuous-improvement',
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      this.emit('error', {
        goalId: 'project',
        phase: 'continuous-improvement',
        error: err,
      });
      this._eventLogger.appendEvent({
        kind: 'error' as never,
        goal_id: 'project',
        phase: 'continuous-improvement',
        error_message: errorMessage,
      });
      this._errorLogger.appendError({
        message: errorMessage,
        goalId: 'project',
        phase: 'continuous-improvement',
      });
    } finally {
      this._improvementDispatchInProgress = false;
    }
  }
}

/**
 * Stuck Agent Supervisor — Background detector for stuck agents
 *
 * Implements the supervisor described in 04-runtime.md §Stuck Agent Detection:
 * - Periodic checks (configurable interval, default 20 min)
 * - Feeds recent logs to a verdict function for structured assessment
 * - After N consecutive stuck verdicts (default 3), selects abort target
 * - Abort priority: reviewer → executor → planner (lower-level first)
 * - Force cancel: if aborted agent doesn't stop within 10 min, sends second cancel
 * - Recovery: when system is no longer stuck, consecutive counter resets
 *
 * The supervisor is dependency-injected through SupervisorDeps so that
 * the check function and session management can be mocked in tests.
 */


// ── Types ─────────────────────────────────────────────────────

/**
 * Structured verdict from the stuck-detection check.
 */
export interface StuckVerdict {
  /** Whether the system appears stuck */
  stuck: boolean;
  /** Confidence in the verdict (0..1) */
  confidence: number;
  /** Human-readable explanation */
  reason: string;
  /** Supporting evidence lines or summaries */
  evidence: string[];
}

/**
 * Configuration for the stuck-agent supervisor.
 *
 * Mirrors the `supervisor` section in the config schema
 * (src/agents/config-schema.ts: supervisorSectionSchema).
 */
export interface SupervisorConfig {
  /** Enable/disable the supervisor. Default: true. */
  enabled: boolean;
  /** Check interval in milliseconds. Default: 1200000 (20 min). */
  intervalMs: number;
  /** Consecutive stuck verdicts required before aborting. Default: 3. */
  consecutiveStuckVerdicts: number;
  /** Number of recent log lines to feed to the check function. Default: 400. */
  logLines: number;
}

/**
 * Default configuration values when a SupervisorConfig is not fully specified.
 */
export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  enabled: true,
  intervalMs: 1_200_000, // 20 minutes
  consecutiveStuckVerdicts: 3,
  logLines: 400,
};

// ── Dependency Injection ──────────────────────────────────────

/**
 * Dependencies injected into StuckAgentSupervisor.
 *
 * All external state (logs, sessions, cancellation, events) is accessed
 * through this interface so tests can substitute mock implementations.
 */
export interface SupervisorDeps {
  /**
   * Retrieve the most recent runtime log lines as a single string.
   * Called on each check cycle.
   */
  getRecentLogs: (maxLines: number) => string;

  /**
   * Return the list of currently active agent sessions.
   * Used to determine which agents are running and to select an abort target.
   */
  getActiveSessions: () => Array<{ role: string; sessionId: string }>;

  /**
   * Request a graceful abort of an agent session.
   * The agent should stop after completing its current tool call.
   */
  abortSession: (sessionId: string) => void;

  /**
   * Force-cancel an agent session — a stronger signal than abortSession.
   * Used when the agent hasn't stopped after the force-cancel timeout.
   */
  forceCancelSession: (sessionId: string) => void;

  /**
   * Emit a runtime event (logs to EventLogger and EventBus).
   * The first argument is the event kind, the second is the event data.
   */
  emitEvent: (kind: string, data: Record<string, unknown>) => void;

  /**
   * Whether the runtime is currently shutting down.
   * When true, the supervisor skips checks and does not start new ones.
   */
  isShuttingDown: () => boolean;
}

// ── Abort Target ──────────────────────────────────────────────

/**
 * Priority order for selecting an abort target.
 * Lower-level agents are aborted first so the planner can handle the
 * failure and retry or escalate.
 *
 * The order is defined in 04-runtime.md §Stuck Agent Detection:
 *   reviewer → executor → planner
 */
const ABORT_PRIORITY: string[] = ['reviewer', 'executor', 'planner'];

// ── Checks Provider ───────────────────────────────────────────

/**
 * A function that inspects recent log lines and returns a structured
 * stuck verdict. In production this is an LLM call; in tests it can be
 * a deterministic function.
 */
export type ChecksProvider = (
  logs: string,
  config: { logLines: number },
) => Promise<StuckVerdict>;

/**
 * Default (no-op) checks provider.
 *
 * In production this will be replaced with a real LLM-based check via
 * the `setChecksProvider()` method or a later integration step.
 * The default implementation always returns `{ stuck: false }` so the
 * supervisor doesn't interfere until a real checker is wired in.
 */
const DEFAULT_CHECK_PROVIDER: ChecksProvider = async (_logs, _config) => ({
  stuck: false,
  confidence: 0,
  reason: 'No check provider configured; defaulting to not-stuck.',
  evidence: [],
});

// ── StuckAgentSupervisor ──────────────────────────────────────

/**
 * Background supervisor that periodically checks whether any agent is
 * stuck (making no progress).
 *
 * ## Lifecycle
 *
 * - Created with `new StuckAgentSupervisor(config, deps)`.
 * - Call `start()` to begin periodic checks.
 * - Call `stop()` to halt checks and clean up timers.
 *
 * ## Abort Flow
 *
 * 1. On each check interval, `_runCheck()` gathers recent logs.
 * 2. The logs are passed to `_checkStuck()` which delegates to the
 *    injectable `_checksProvider`.
 * 3. If the verdict is `stuck: true`, the consecutive counter increments.
 *    If `stuck: false`, the counter resets to 0.
 * 4. When `_consecutiveStuckCount >= config.consecutiveStuckVerdicts`
 *    AND no abort has been issued for the current episode:
 *    - `_selectAbortTarget()` picks the lowest-priority active agent
 *      (reviewer → executor → planner).
 *    - `_sendAbort(target)` calls `abortSession()` and starts a
 *      10-minute force-cancel timer.
 * 5. If the force-cancel timer fires and the session is still active,
 *    `_sendForceCancel()` calls `forceCancelSession()`.
 * 6. A single "not stuck" verdict resets both `_consecutiveStuckCount`
 *    and the `_aborted` flag, allowing the supervisor to re-detect a
 *    new stuck episode.
 *
 * ## Thread Safety
 *
 * The supervisor uses `setInterval` and `setTimeout`. Check cycles are
 * serialized by a `_checkInProgress` flag — if a check is already
 * running when the interval fires, the interval is skipped.
 */
export class StuckAgentSupervisor {
  private _config: SupervisorConfig;
  private _deps: SupervisorDeps;
  private _checksProvider: ChecksProvider;

  /** Number of consecutive `stuck: true` verdicts */
  private _consecutiveStuckCount = 0;

  /** Whether an abort has been issued in the current stuck episode */
  private _aborted = false;

  /** Interval timer for periodic checks */
  private _intervalTimer: ReturnType<typeof setInterval> | null = null;

  /** Force-cancel timeout for the currently aborted session */
  private _forceCancelTimer: ReturnType<typeof setTimeout> | null = null;

  /** The session ID currently targeted for abort (used by force-cancel) */
  private _abortTarget: { role: string; sessionId: string } | null = null;

  /** True while `_runCheck()` is executing, prevents overlapping checks */
  private _checkInProgress = false;

  /** Total number of check cycles performed since last start */
  private _checksPerformed = 0;

  /** Whether `start()` has been called and `stop()` has not */
  private _running = false;

  /** Grace period after abort before re-checking for stuckness (avoids
   *  false positive 'not stuck' from the aborted agent dropping) */
  private static readonly ABORT_GRACE_MS = 60_000; // 1 minute

  /** Force-cancel delay after initial abort (ms). Default: 10 minutes. */
  private static readonly FORCE_CANCEL_DELAY_MS = 600_000; // 10 minutes

  /** Time the last abort was issued */
  private _lastAbortAt = 0;

  constructor(config: SupervisorConfig, deps: SupervisorDeps) {
    this._config = { ...DEFAULT_SUPERVISOR_CONFIG, ...config };
    this._deps = deps;
    this._checksProvider = DEFAULT_CHECK_PROVIDER;
  }

  // ── Public Methods ──────────────────────────────────────────

  /**
   * Begin periodic checks at the configured interval (`config.intervalMs`).
   *
   * No-op if already running or if `config.enabled` is false.
   * Emits `stuck_supervisor_started` event.
   */
  start(): void {
    if (this._running) return;
    if (!this._config.enabled) return;

    this._running = true;
    this._consecutiveStuckCount = 0;
    this._aborted = false;
    this._checksPerformed = 0;
    this._checkInProgress = false;

    this._deps.emitEvent('stuck_supervisor_started', {
      interval_ms: this._config.intervalMs,
      consecutive_threshold: this._config.consecutiveStuckVerdicts,
    });

    // Schedule the first check immediately after a short delay to let
    // the runtime fully initialize.
    this._intervalTimer = setInterval(() => {
      void this._runCheck();
    }, this._config.intervalMs);

    // Don't wait for the first interval — run an initial check after
    // a minimal delay so the supervisor doesn't sit idle for 20 min
    // on a fresh start.
    setTimeout(() => {
      void this._runCheck();
    }, 1000);

    // unref the interval to not keep the process alive
    this._intervalTimer.unref();
  }

  /**
   * Stop periodic checks and clear all timers.
   *
   * No-op if not running. Safe to call multiple times.
   * Emits `stuck_supervisor_stopped` event.
   */
  stop(): void {
    if (!this._running) return;

    this._running = false;

    if (this._intervalTimer !== null) {
      clearInterval(this._intervalTimer);
      this._intervalTimer = null;
    }

    if (this._forceCancelTimer !== null) {
      clearTimeout(this._forceCancelTimer);
      this._forceCancelTimer = null;
    }

    this._deps.emitEvent('stuck_supervisor_stopped', {
      checks_performed: this._checksPerformed,
    });
  }

  /**
   * Replace the checks provider (e.g. inject an LLM-based checker
   * or a mock for testing). Must be called before `start()` to
   * take effect for the first check cycle.
   */
  setChecksProvider(provider: ChecksProvider): void {
    this._checksProvider = provider;
  }

  // ── Accessors (for testing) ─────────────────────────────────

  /** Current consecutive stuck verdict count (for test assertions). */
  get consecutiveStuckCount(): number {
    return this._consecutiveStuckCount;
  }

  /** Whether the supervisor is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** Whether an abort has been issued in the current episode. */
  get aborted(): boolean {
    return this._aborted;
  }

  // ── Internal: Check Cycle ───────────────────────────────────

  /**
   * Execute one check cycle: gather logs, evaluate stuckness, and
   * act on the verdict.
   *
   * Skips if already running, shutting down, or in abort grace period.
   */
  private async _runCheck(): Promise<void> {
    // Prevent overlapping checks
    if (this._checkInProgress) return;
    if (!this._running) return;
    if (this._deps.isShuttingDown()) return;

    // Grace period after an abort — don't re-check immediately because
    // the abort itself changes the log content and can produce a false
    // "not stuck" verdict.
    if (this._aborted && Date.now() - this._lastAbortAt < StuckAgentSupervisor.ABORT_GRACE_MS) {
      return;
    }

    this._checkInProgress = true;

    try {
      this._checksPerformed++;

      // 1. Gather recent logs
      const logs = this._deps.getRecentLogs(this._config.logLines);

      // 2. Get the verdict
      const verdict = await this._checkStuck(logs);

      // 3. Emit the verdict event
      this._deps.emitEvent('stuck_verdict', {
        verdict: verdict.stuck,
        confidence: verdict.confidence,
        reason: verdict.reason,
        evidence: verdict.evidence,
        consecutive_count: this._consecutiveStuckCount,
        threshold: this._config.consecutiveStuckVerdicts,
      });

      // 4. Update state based on verdict
      if (verdict.stuck) {
        this._consecutiveStuckCount++;

        // Check if we should abort
        if (
          this._consecutiveStuckCount >= this._config.consecutiveStuckVerdicts &&
          !this._aborted
        ) {
          const target = this._selectAbortTarget();
          if (target) {
            this._sendAbort(target);
          }
        }
      } else {
        // Recovery: system is no longer stuck
        this._consecutiveStuckCount = 0;
        this._aborted = false;
      }
    } finally {
      this._checkInProgress = false;
    }
  }

  // ── Internal: Stuck Check ───────────────────────────────────

  /**
   * Delegate to the injectable checks provider to evaluate whether
   * the system appears stuck based on recent log output.
   */
  private async _checkStuck(logs: string): Promise<StuckVerdict> {
    return this._checksProvider(logs, {
      logLines: this._config.logLines,
    });
  }

  // ── Internal: Abort Target Selection ────────────────────────

  /**
   * Select the abort target per the priority order:
   *   reviewer → executor → planner (lower-level first).
   *
   * Only sessions returned by `getActiveSessions()` are considered.
   * Returns null if no matching active session is found.
   */
  private _selectAbortTarget(): { role: string; sessionId: string } | null {
    const sessions = this._deps.getActiveSessions();

    if (sessions.length === 0) return null;

    for (const role of ABORT_PRIORITY) {
      const match = sessions.find((s) => s.role === role);
      if (match) {
        return match;
      }
    }

    // Fallback: return the first active session (any role)
    return sessions[0] ?? null;
  }

  // ── Internal: Abort / Force-Cancel ──────────────────────────

  /**
   * Issue an abort to the selected target, emit the event, and schedule
   * a force-cancel timeout.
   */
  private _sendAbort(target: { role: string; sessionId: string }): void {
    this._aborted = true;
    this._abortTarget = target;
    this._lastAbortAt = Date.now();

    this._deps.emitEvent('abort_target_selected', {
      target_role: target.role,
      target_session_id: target.sessionId,
      reason: `System stuck after ${this._consecutiveStuckCount} consecutive verdicts`,
      consecutive_count: this._consecutiveStuckCount,
    });

    this._deps.abortSession(target.sessionId);

    // Schedule force-cancel timeout
    this._forceCancelTimer = setTimeout(() => {
      // Re-check: is the target still active?
      const sessions = this._deps.getActiveSessions();
      const stillActive = sessions.some(
        (s) => s.sessionId === target.sessionId,
      );

      if (stillActive) {
        this._sendForceCancel(target);
      }

      this._forceCancelTimer = null;
    }, StuckAgentSupervisor.FORCE_CANCEL_DELAY_MS);

    this._forceCancelTimer.unref();
  }

  /**
   * Send a second, stronger cancel signal (force cancel) to the
   * abort target that did not stop within the grace period.
   */
  private _sendForceCancel(target: { role: string; sessionId: string }): void {
    this._deps.emitEvent('force_cancel_sent', {
      target_role: target.role,
      target_session_id: target.sessionId,
      reason: `Agent '${target.role}' (${target.sessionId}) did not stop within ` +
        `${StuckAgentSupervisor.FORCE_CANCEL_DELAY_MS / 60_000} minutes of abort`,
    });

    this._deps.forceCancelSession(target.sessionId);
  }
}

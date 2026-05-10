import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import type {
  CardRecord,
  RuntimeState,
  ReviewAssessment,
  RuntimeStatus as RStatus,
} from '../schemas/types.js';
import { CardStore } from './card-store.js';
import {
  initRuntimeState,
  readRuntimeState,
  saveRuntimeState,
  updateRuntimeState,
} from './runtime-state.js';
import { acquireLock, releaseLock } from './runtime-lock.js';
import { FakeAgentAdapter, type FakeAgentConfig } from './fake-agent.js';

// ── Types ─────────────────────────────────────────────────────

export type RuntimeStatus = RStatus;

export interface RuntimeConfig {
  projectRoot: string;
  fakeAgentConfig: FakeAgentConfig;
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

// ── Runtime Class ────────────────────────────────────────────

export class Runtime extends EventEmitter {
  readonly projectRoot: string;
  readonly cardStore: CardStore;
  readonly fakeAgent: FakeAgentAdapter;

  private _status: RuntimeStatus = 'idle';
  private _paused: boolean = false;
  private _running: boolean = false;
  private _shuttingDown: boolean = false;

  constructor(config: RuntimeConfig) {
    super();
    this.projectRoot = config.projectRoot;
    this.cardStore = new CardStore(config.projectRoot);
    this.fakeAgent = new FakeAgentAdapter(config.fakeAgentConfig);
  }

  get status(): RuntimeStatus {
    return this._status;
  }

  get paused(): boolean {
    return this._paused;
  }

  // ── Startup ───────────────────────────────────────────────

  /**
   * Startup sequence:
   * 1. Discover project (already known via projectRoot)
   * 2. Init/load runtime state
   * 3. Acquire runtime lock
   * 4. Crash recovery (reset active/running cards to backlog)
   * 5. Write initial runtime state
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

    // 4. Write initial state
    state = initRuntimeState(this.projectRoot);
    this._status = 'idle';
    this._paused = false;
    this._running = true;
    this._shuttingDown = false;

    this.emit('started', { projectRoot: this.projectRoot });
  }

  // ── Shutdown ──────────────────────────────────────────────

  /**
   * Graceful shutdown:
   * 1. Freeze tracker (stop new dispatch)
   * 2. Write shutdown state (idle)
   * 3. Release lock
   */
  async shutdown(): Promise<void> {
    if (!this._running) return;

    this._shuttingDown = true;
    this._running = false;

    // Write final idle state
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

    // Release lock
    try {
      releaseLock(this.projectRoot);
    } catch {
      // Best effort
    }

    this._status = 'idle';
    this.emit('shutdown');
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
    const stashDir = join(this.projectRoot, '.saivage-work', 'tmp', 'stash');
    if (existsSync(stashDir)) {
      try {
        const entries = readdirSync(stashDir);
        const cutoff = Date.now() - 24 * 60 * 60 * 1000;
        for (const entry of entries) {
          try {
            const fullPath = join(stashDir, entry);
            const st = statSync(fullPath);
            if (st.mtimeMs < cutoff) {
              rmSync(fullPath, { recursive: true, force: true });
            }
          } catch {
            // ignore per-file errors
          }
        }
      } catch {
        // ignore broader errors
      }
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

    const relevantCards = allCards.filter((c) => descendantIds.has(c.id) && isTerminal(c));

    return buildReadyQueue(relevantCards);
  }

  // ── Dispatch Logic ────────────────────────────────────────

  /**
   * Run the full goal flow: planner → executor → reviewer loop.
   *
   * This is the main dispatch method. It simulates the full lifecycle
   * using fake agents.
   *
   * Runtime state is persisted at key transitions so crash recovery
   * can resume from the last known point.
   *
   * @param goalId - The goal (or project) card ID to process.
   */
  async dispatchGoal(goalId: string): Promise<void> {
    if (this._paused) {
      this.emit('dispatch_blocked', { reason: 'paused', goalId });
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
      this.emit('error', { goalId, phase: 'activate', error: err });
      return;
    }

    // Main loop: planner → executor(s) → reviewer
    let plannerDone = false;
    const MAX_ITERATIONS = 50; // safety limit to prevent infinite loops

    for (let iter = 0; iter < MAX_ITERATIONS && !plannerDone && !this._shuttingDown; iter++) {
      if (this._paused) {
        this.emit('dispatch_blocked', { reason: 'paused', goalId });
        updateRuntimeState(this.projectRoot, { status: 'paused' });
        return;
      }

      // Step 2: Invoke the planner
      let plannerResult;
      try {
        plannerResult = this.fakeAgent.invokePlanner(goalId);
      } catch (err) {
        this.emit('error', { goalId, phase: 'planner', error: err });
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
        return;
      }

      // Step 4: If planner declared done, invoke reviewer
      if (plannerDone) {
        const reviewResult = this.invokeReviewer(goalId, planCard.id);

        if (reviewResult.assessment.result === 'pass') {
          // Goal done!
          this.cardStore.setStatus(goalId, 'done');
          // Persist final state
          updateRuntimeState(this.projectRoot, {
            status: 'idle',
            current_card_id: null,
            current_agent_session_id: null,
            queue: [],
          });
          this.emit('goal_completed', { goalId, assessment: reviewResult.assessment });
          return;
        } else {
          // Review failed — re-invoke planner
          plannerDone = false;
          this.emit('review_failed', { goalId, assessment: reviewResult.assessment });
        }
      }
    }

    if (this._shuttingDown) {
      this.emit('dispatch_interrupted', { goalId, reason: 'shutdown' });
    }
  }

  /**
   * Execute all ready terminal cards under a goal.
   */
  private async executeReadyCards(goalId: string): Promise<void> {
    let readyCards = this.getReadyQueue(goalId);

    while (readyCards.length > 0 && !this._shuttingDown) {
      if (this._paused) return;

      for (const card of readyCards) {
        if (this._shuttingDown || this._paused) return;

        // Set card to running
        this.cardStore.setStatus(card.id, 'running');

        // Persist current_card_id to track what's running
        updateRuntimeState(this.projectRoot, { current_card_id: card.id });

        // Invoke executor
        let execResult;
        try {
          execResult = this.fakeAgent.invokeExecutor(card.id, goalId);
        } catch (err) {
          this.emit('error', { cardId: card.id, goalId, phase: 'executor', error: err });
          this.cardStore.setStatus(card.id, 'failed');
          // Failed terminal card re-invokes parent planner
          this.emit('card_failed', { cardId: card.id, goalId });
          return; // stop processing siblings, planner will be re-invoked
        }

        // Apply executor result
        this.cardStore.update(card.id, {
          status: execResult.status,
          result: execResult.result ?? null,
          error: execResult.error ?? null,
        });

        if (execResult.status === 'failed') {
          this.emit('card_failed', { cardId: card.id, goalId });
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
   */
  invokeReviewer(
    goalId: string,
    _planCardId: string,
  ): {
    assessment: ReviewAssessment;
  } {
    const result = this.fakeAgent.invokeReviewer(goalId);
    this.emit('review_complete', { goalId, assessment: result.assessment });
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
    plannerResult: {
      created_cards?: Array<{
        id?: string;
        type: string;
        title: string;
        description: string;
        status: string;
        depends_on: string[];
        priority: number;
        tags?: string[];
      }>;
      updated_cards?: Array<{
        id: string;
        status?: string;
        title?: string;
        description?: string;
      }>;
    },
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
        if (update.status !== undefined) changes.status = update.status as CardRecord['status'];
        if (update.title !== undefined) changes.title = update.title;
        if (update.description !== undefined) changes.description = update.description;
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

  // ── Utility ────────────────────────────────────────────────

  /**
   * Get the current runtime state as a RuntimeState object
   * (as opposed to what's on disk).
   */
  getState(): RuntimeState | null {
    return readRuntimeState(this.projectRoot);
  }
}

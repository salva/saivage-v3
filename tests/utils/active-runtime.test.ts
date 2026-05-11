/**
 * Stage 18 — ActiveRuntime Unit Tests
 *
 * Tests for the ActiveRuntime class covering:
 *   1. Construction with in-memory config (no config file needed)
 *   2. start/stop lifecycle and lock management
 *   3. dispatchGoal delegation to Runtime
 *   4. pause/resume and state changes
 *   5. getStatus after various lifecycle stages
 *   6. Accessors (runtime, eventLogger, agentAdapter)
 */

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { releaseLock, isLocked } from '../../src/utils/runtime-lock.js';
import { ActiveRuntime } from '../../src/utils/active-runtime.js';
import type { CardRecord } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

function setupProjectWithConfig(projectRoot: string): void {
  initProjectTree(projectRoot);

  const sd = join(projectRoot, '.saivage');
  const now = new Date().toISOString();

  // Write minimal saivage.json
  writeFileSync(
    join(sd, 'saivage.json'),
    JSON.stringify({
      server: { port: 8080, host: '127.0.0.1' },
      models: { default: ['test-model'] },
      providers: {
        test: {
          priority: 10,
          models: ['test-model'],
          apiKey: 'test-api-key',
        },
      },
    }, null, 2),
  );

  // Write runtime state
  writeFileSync(
    join(sd, 'runtime', 'state.json'),
    JSON.stringify({
      status: 'idle',
      project_id: 'project',
      pid: process.pid,
      started_at: now,
      current_card_id: null,
      current_agent_session_id: null,
      paused: false,
      paused_at: null,
      queue: [],
      running_processes: [],
      updated_at: now,
    }, null, 2),
  );
}

function makeGoalCard(store: CardStore, id: string, title: string): CardRecord {
  return store.create({
    id,
    type: 'goal',
    parent: 'project',
    depth: 0,
    title,
    description: `Goal: ${title}`,
    status: 'backlog',
    tags: [],
    priority: 1,
    urgency: 'normal',
    created_by: 'analyst',
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: `Acceptance for ${title}`,
    artifacts: [],
    attachments: [],
    retries: 0,
  });
}

// ═══════════════════════════════════════════════════════════════
// Test Suite: ActiveRuntime
// ═══════════════════════════════════════════════════════════════

describe('ActiveRuntime', () => {
  let tmpDir: string;
  let activeRuntime: ActiveRuntime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ar-'));
    setupProjectWithConfig(tmpDir);
  });

  afterEach(() => {
    // Release any leftover lock
    try {
      releaseLock(tmpDir);
    } catch {
      // ignore
    }

    // Clean up temp dir
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ═════════════════════════════════════════════════════════════
  // AC: Construction and basic accessors
  // ═════════════════════════════════════════════════════════════

  describe('Construction and accessors', () => {
    it('creates an ActiveRuntime with a temp project root', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      expect(activeRuntime).toBeDefined();
      expect(activeRuntime.runtime).toBeDefined();
      expect(activeRuntime.eventLogger).toBeDefined();
      expect(activeRuntime.agentAdapter).toBeDefined();
    });

    it('getStatus returns expected defaults before start', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const status = activeRuntime.getStatus();
      expect(status.status).toBe('idle');
      expect(status.paused).toBe(false);
      expect(status.currentCardId).toBeNull();
      expect(typeof status.goalCount).toBe('number');
    });

    it('runtime cardStore is accessible and functional', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const store = activeRuntime.runtime.cardStore;
      expect(store).toBeDefined();
      // Project card should exist (created by initProjectTree)
      const project = store.read('project');
      expect(project).not.toBeNull();
      expect(project!.type).toBe('project');
    });
  });

  // ═════════════════════════════════════════════════════════════
  // AC: start/stop lifecycle and lock management
  // ═════════════════════════════════════════════════════════════

  describe('start/stop lifecycle', () => {
    it('start() acquires the runtime lock', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();

      // Lock should be held
      expect(isLocked(tmpDir)).toBe(true);

      await activeRuntime.stop();
    });

    it('stop() releases the runtime lock', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      expect(isLocked(tmpDir)).toBe(true);

      await activeRuntime.stop();
      expect(isLocked(tmpDir)).toBe(false);
    });

    it('getStatus after start shows idle status', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();

      const status = activeRuntime.getStatus();
      expect(status.status).toBe('idle');
      expect(status.paused).toBe(false);

      await activeRuntime.stop();
    });

    it('stop() is idempotent — calling multiple times does not throw', async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
      await activeRuntime.stop();

      // Second stop should not throw
      await activeRuntime.stop();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // AC: pause/resume and state changes
  // ═════════════════════════════════════════════════════════════

  describe('pause / resume', () => {
    beforeEach(async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
    });

    afterEach(async () => {
      await activeRuntime.stop();
    });

    it('pause() sets paused to true', () => {
      activeRuntime.pause();
      const status = activeRuntime.getStatus();
      expect(status.paused).toBe(true);
      // Note: the Runtime._status field is only updated on disk (via
      // updateRuntimeState), not in the in-memory _status field. So
      // status.status stays 'idle'. paused is the in-memory flag.
    });

    it('resume() sets paused to false', () => {
      activeRuntime.pause();
      activeRuntime.resume();
      const status = activeRuntime.getStatus();
      expect(status.paused).toBe(false);
    });

    it('pause and resume are idempotent', () => {
      // Double pause
      activeRuntime.pause();
      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      // Double resume
      activeRuntime.resume();
      activeRuntime.resume();
      expect(activeRuntime.getStatus().paused).toBe(false);
    });
  });

  // ═════════════════════════════════════════════════════════════
  // AC: dispatchGoal delegation to Runtime
  // ═════════════════════════════════════════════════════════════

  describe('dispatchGoal', () => {
    beforeEach(async () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      await activeRuntime.start();
    });

    afterEach(async () => {
      await activeRuntime.stop();
    });

    it('dispatchGoal exists and is callable (method presence)', () => {
      // Just verify the method exists and has the right signature
      expect(typeof activeRuntime.dispatchGoal).toBe('function');
    });

    it('dispatchGoal while paused blocks the dispatch', async () => {
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-test-paused', 'Paused Dispatch Goal');

      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      // Dispatch should be blocked (the runtime emits dispatch_blocked but
      // doesn't throw — it just returns early)
      await activeRuntime.dispatchGoal('goal-test-paused');

      // Goal should still be in backlog
      const goal = store.read('goal-test-paused');
      expect(goal!.status).toBe('backlog');

      // Resume and verify no crash
      activeRuntime.resume();
    });
  });

  // ═════════════════════════════════════════════════════════════
  // AC: getStatus reflects runtime state
  // ═════════════════════════════════════════════════════════════

  describe('getStatus', () => {
    it('getStatus reports goalCount correctly', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      const store = new CardStore(tmpDir);

      // Before creating goals — should be 0
      expect(activeRuntime.getStatus().goalCount).toBe(0);

      // Create a goal
      makeGoalCard(store, 'goal-status-1', 'Status Test Goal 1');
      // Need a fresh ActiveRuntime to pick up the card (card store reads from disk)
      const ar2 = new ActiveRuntime(tmpDir);
      expect(ar2.getStatus().goalCount).toBe(1);

      // Create another goal
      makeGoalCard(store, 'goal-status-2', 'Status Test Goal 2');
      const ar3 = new ActiveRuntime(tmpDir);
      expect(ar3.getStatus().goalCount).toBe(2);
    });

    it('getStatus reflects pause state via the paused flag', () => {
      activeRuntime = new ActiveRuntime(tmpDir);
      expect(activeRuntime.getStatus().paused).toBe(false);

      activeRuntime.pause();
      expect(activeRuntime.getStatus().paused).toBe(true);

      activeRuntime.resume();
      expect(activeRuntime.getStatus().paused).toBe(false);
    });
  });
});

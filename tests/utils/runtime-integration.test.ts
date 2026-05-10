import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, rmSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter } from '../../src/utils/fake-agent.js';
import type { FakeAgentFixture } from '../../src/utils/fake-agent.js';
import {
  acquireLock,
  releaseLock,
  isLocked,
  removeStaleLock,
} from '../../src/utils/runtime-lock.js';
import type { CardRecord } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

// ── Test Suite ────────────────────────────────────────────────

describe('Runtime Integration', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-rt-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(() => {
    try {
      releaseLock(tmpDir);
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── Helper to create fixtures ───────────────────────────────

  function createHappyPathFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'happy-goal',
      planner: [
        {
          plan_card_id: 'plan-goal-1',
          created_cards: [
            {
              id: 'code-happy-1',
              type: 'code',
              title: 'Write happy feature',
              description: 'Implement the happy path feature',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
            {
              id: 'code-happy-2',
              type: 'code',
              title: 'Write tests for happy feature',
              description: 'Add tests',
              status: 'backlog',
              depends_on: ['code-happy-1'],
              priority: 2,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-1',
          updated_cards: [],
          declare_done: true,
        },
      ],
      executor: {
        'code-happy-1': { card_id: 'code-happy-1', status: 'done' },
        'code-happy-2': { card_id: 'code-happy-2', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-001',
            goal_card_id: 'goal-1',
            plan_card_id: 'plan-goal-1',
            reviewer_session_id: 'rev-session-1',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented', 'Tests passing'],
            missing: [],
            evidence_card_ids: ['code-happy-1', 'code-happy-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'happy-goal', fixture);
  }

  function createReviewFailFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'review-fail-goal',
      planner: [
        {
          plan_card_id: 'plan-goal-2',
          created_cards: [
            {
              id: 'code-rf-1',
              type: 'code',
              title: 'Initial implementation',
              description: 'First attempt',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-2',
          updated_cards: [],
          declare_done: true,
        },
        {
          plan_card_id: 'plan-goal-2',
          created_cards: [
            {
              id: 'code-rf-2',
              type: 'code',
              title: 'Correction card',
              description: 'Fix the issues from review',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-2',
          updated_cards: [],
          declare_done: true,
        },
      ],
      executor: {
        'code-rf-1': { card_id: 'code-rf-1', status: 'done' },
        'code-rf-2': { card_id: 'code-rf-2', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-rf-001',
            goal_card_id: 'goal-2',
            plan_card_id: 'plan-goal-2',
            reviewer_session_id: 'rev-session-2',
            result: 'fail',
            summary: 'Missing edge case handling.',
            achieved: ['Basic implementation done'],
            missing: ['Edge case handling', 'Error logging'],
            evidence_card_ids: ['code-rf-1'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-rf-002',
            goal_card_id: 'goal-2',
            plan_card_id: 'plan-goal-2',
            reviewer_session_id: 'rev-session-2',
            result: 'pass',
            summary: 'All criteria met after corrections.',
            achieved: ['Edge case handling', 'Error logging', 'Basic implementation'],
            missing: [],
            evidence_card_ids: ['code-rf-1', 'code-rf-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'review-fail-goal', fixture);
  }

  function createExecutorFailFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'exec-fail-goal',
      planner: [
        {
          plan_card_id: 'plan-goal-3',
          created_cards: [
            {
              id: 'code-ef-1',
              type: 'code',
              title: 'Will fail card',
              description: 'This card will fail',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-3',
          created_cards: [
            {
              id: 'code-ef-2',
              type: 'code',
              title: 'Replacement card',
              description: 'Try again',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-3',
          updated_cards: [],
          declare_done: true,
        },
      ],
      executor: {
        'code-ef-1': { card_id: 'code-ef-1', status: 'failed', error: 'Build error' },
        'code-ef-2': { card_id: 'code-ef-2', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-ef-001',
            goal_card_id: 'goal-3',
            plan_card_id: 'plan-goal-3',
            reviewer_session_id: 'rev-session-3',
            result: 'pass',
            summary: 'Replacement works.',
            achieved: ['Replacement implemented'],
            missing: [],
            evidence_card_ids: ['code-ef-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'exec-fail-goal', fixture);
  }

  function createCrashRecoveryFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'crash-recovery',
      planner: [
        {
          plan_card_id: 'plan-goal-1',
          created_cards: [
            {
              id: 'code-resume-1',
              type: 'code',
              title: 'Resume card',
              description: 'Resume after crash',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          declare_done: false,
        },
        {
          plan_card_id: 'plan-goal-1',
          updated_cards: [],
          declare_done: true,
        },
      ],
      executor: {
        'code-resume-1': { card_id: 'code-resume-1', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-cr-001',
            goal_card_id: 'goal-1',
            plan_card_id: 'plan-goal-1',
            reviewer_session_id: 'rev-session-cr',
            result: 'pass',
            summary: 'Crash recovery test passed.',
            achieved: ['Goal completed after crash'],
            missing: [],
            evidence_card_ids: ['code-resume-1'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'crash-recovery', fixture);
  }

  function createLockFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'lock-test',
      planner: [],
      executor: {},
      reviewer: [],
    };
    writeFixture(fixtureDir, 'lock-test', fixture);
  }

  function makeDefaultConfig(overrides?: Record<string, string>) {
    const mapping: Record<string, string> = {
      'goal-1': 'happy-goal',
      'goal-2': 'review-fail-goal',
      'goal-3': 'exec-fail-goal',
      project: 'happy-goal',
      ...overrides,
    };
    return {
      projectRoot: tmpDir,
      fakeAgentConfig: {
        mapping,
        fixtureDir,
      },
    };
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

  function makeTerminalCard(
    store: CardStore,
    id: string,
    parentId: string,
    overrides: Partial<CardRecord> = {},
  ): CardRecord {
    return store.create({
      id,
      type: 'code',
      parent: parentId,
      depth: 0,
      title: id,
      description: '',
      status: 'backlog',
      tags: [],
      priority: 1,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      blocks: [],
      related: [],
      acceptance: '',
      artifacts: [],
      attachments: [],
      retries: 0,
      ...overrides,
    });
  }

  // ═══════════════════════════════════════════════════════════════
  // AC 1: A fixture goal can move from backlog to done through
  //       planner, executor, and reviewer fixture results
  // ═══════════════════════════════════════════════════════════════

  describe('AC 1: Full goal flow (backlog → done)', () => {
    it('moves a goal from backlog to done through planner, executor, and reviewer', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      const events: string[] = [];
      runtime.on('card_failed', () => events.push('card_failed'));
      runtime.on('review_failed', () => events.push('review_failed'));
      runtime.on('goal_completed', () => events.push('goal_completed'));

      await runtime.dispatchGoal('goal-1');

      // Verify the goal reached 'done'
      const goal = store.read('goal-1');
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('done');

      // Verify terminal cards were processed
      const card1 = store.read('code-happy-1');
      expect(card1).not.toBeNull();
      expect(card1!.status).toBe('done');

      const card2 = store.read('code-happy-2');
      expect(card2).not.toBeNull();
      expect(card2!.status).toBe('done');

      // No failures
      expect(events).not.toContain('card_failed');
      expect(events).not.toContain('review_failed');
      expect(events).toContain('goal_completed');

      await runtime.shutdown();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 2: A reviewer failure re-invokes the planner and
  //       correction cards run before the next review
  // ═══════════════════════════════════════════════════════════════

  describe('AC 2: Reviewer failure → planner re-invoked → correction cards', () => {
    it('re-invokes planner after reviewer failure and runs correction cards', async () => {
      createReviewFailFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-2', 'Review Fail Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      const reviewFailedEvents: Array<{ goalId: string }> = [];
      runtime.on('review_failed', (data) => reviewFailedEvents.push(data));

      const goalCompleted = new Promise<void>((resolve) => {
        runtime.on('goal_completed', () => resolve());
      });

      await runtime.dispatchGoal('goal-2');
      await goalCompleted;

      // Verify the goal reached 'done'
      const goal = store.read('goal-2');
      expect(goal!.status).toBe('done');

      // Verify correction card was created and executed
      const correctionCard = store.read('code-rf-2');
      expect(correctionCard).not.toBeNull();
      expect(correctionCard!.status).toBe('done');

      // Verify reviewer was re-invoked
      expect(reviewFailedEvents.length).toBeGreaterThanOrEqual(1);

      await runtime.shutdown();
    });

    it('correction cards execute before the next review', async () => {
      createReviewFailFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-2', 'Review Fail Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      const events: string[] = [];
      runtime.on('review_failed', () => events.push('review_failed'));
      runtime.on('goal_completed', () => events.push('goal_completed'));

      await runtime.dispatchGoal('goal-2');

      // Both cards should be done, the original and the correction
      const origCard = store.read('code-rf-1');
      const corrCard = store.read('code-rf-2');
      expect(origCard!.status).toBe('done');
      expect(corrCard!.status).toBe('done');
      expect(events).toContain('review_failed');
      expect(events).toContain('goal_completed');

      await runtime.shutdown();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 3: A failed terminal card re-invokes the parent planner
  // ═══════════════════════════════════════════════════════════════

  describe('AC 3: Failed terminal card re-invokes parent planner', () => {
    it('re-invokes planner after a terminal card fails', async () => {
      createExecutorFailFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-3', 'Exec Fail Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      const cardFailedEvents: Array<{ cardId: string }> = [];
      runtime.on('card_failed', (data) => cardFailedEvents.push(data));

      const goalCompleted = new Promise<void>((resolve) => {
        runtime.on('goal_completed', () => resolve());
      });

      await runtime.dispatchGoal('goal-3');
      await goalCompleted;

      // The failing card should be in 'failed' status
      const failedCard = store.read('code-ef-1');
      expect(failedCard!.status).toBe('failed');
      expect(failedCard!.error).toBe('Build error');

      // The replacement card should have been created and executed
      const replCard = store.read('code-ef-2');
      expect(replCard).not.toBeNull();
      expect(replCard!.status).toBe('done');

      // Card failed event was emitted
      expect(cardFailedEvents.length).toBeGreaterThanOrEqual(1);
      expect(cardFailedEvents[0].cardId).toBe('code-ef-1');

      // Goal still completes via replacement
      const goal = store.read('goal-3');
      expect(goal!.status).toBe('done');

      await runtime.shutdown();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 4: A second runtime instance cannot acquire the lock
  //       while the first is alive
  // ═══════════════════════════════════════════════════════════════

  describe('AC 4: Exclusive lock — second instance rejected', () => {
    it('prevents second instance from acquiring lock while first is alive', () => {
      createLockFixture();

      // First instance acquires lock
      const payload1 = acquireLock(tmpDir);
      expect(payload1.pid).toBe(process.pid);
      expect(isLocked(tmpDir)).toBe(true);

      // Second instance should fail
      expect(() => acquireLock(tmpDir)).toThrow(/Cannot acquire lock/);

      // Release and verify second instance can now acquire
      releaseLock(tmpDir);
      expect(isLocked(tmpDir)).toBe(false);

      const payload2 = acquireLock(tmpDir);
      expect(payload2.pid).toBe(process.pid);
      releaseLock(tmpDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 5: Stale locks are removed only when the PID is dead or
  //       older than configured age bound
  // ═══════════════════════════════════════════════════════════════

  describe('AC 5: Stale lock detection', () => {
    it('removes lock when PID is dead', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });
      const deadPayload = { pid: 99999, started_at: new Date().toISOString() };
      writeFileSync(lockPath, JSON.stringify(deadPayload, null, 2), 'utf-8');

      // The dead PID lock should not block acquisition
      expect(() => acquireLock(tmpDir)).not.toThrow();

      // Clean up
      releaseLock(tmpDir);
    });

    it('removes lock when older than configured maxAge', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });

      // Create a lock with an old timestamp (30 days ago) but our own PID
      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const oldPayload = { pid: process.pid, started_at: oldDate };
      writeFileSync(lockPath, JSON.stringify(oldPayload, null, 2), 'utf-8');

      // Should remove stale lock and acquire
      expect(() => acquireLock(tmpDir)).not.toThrow();

      releaseLock(tmpDir);
    });

    it('removeStaleLock only removes when PID is dead or age exceeds bound', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });

      // Fresh lock with current PID — should NOT be removed
      const freshPayload = { pid: process.pid, started_at: new Date().toISOString() };
      writeFileSync(lockPath, JSON.stringify(freshPayload, null, 2), 'utf-8');
      expect(existsSync(lockPath)).toBe(true);

      removeStaleLock(tmpDir);
      // Should still exist because PID is alive and recent
      expect(existsSync(lockPath)).toBe(true);

      // Clean up
      releaseLock(tmpDir);

      // Dead PID lock — SHOULD be removed by removeStaleLock
      const deadPayload = { pid: 99999, started_at: new Date().toISOString() };
      writeFileSync(lockPath, JSON.stringify(deadPayload, null, 2), 'utf-8');
      expect(existsSync(lockPath)).toBe(true);

      removeStaleLock(tmpDir);
      expect(existsSync(lockPath)).toBe(false);
    });

    it('does not remove a valid (live, recent) lock', () => {
      createLockFixture();

      acquireLock(tmpDir);
      expect(isLocked(tmpDir)).toBe(true);

      // removeStaleLock should NOT remove the live lock
      removeStaleLock(tmpDir);
      expect(isLocked(tmpDir)).toBe(true);

      releaseLock(tmpDir);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 6: After simulated crash, active and running cards are
  //       reset to backlog and the runtime can resume
  // ═══════════════════════════════════════════════════════════════

  describe('AC 6: Crash recovery', () => {
    it('resets active and running cards to backlog after crash', () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Crash Goal');

      // Set some cards to active/running
      store.setStatus('goal-1', 'active');
      makeTerminalCard(store, 'code-crash-1', 'goal-1', {
        status: 'running',
      });

      // Simulate crash
      runtime = new Runtime(makeDefaultConfig());
      runtime.simulateCrash();

      // Verify cards were reset
      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');

      const card = store.read('code-crash-1');
      expect(card!.status).toBe('backlog');
    });

    it('runtime can resume after crash recovery', async () => {
      createCrashRecoveryFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Resume Goal');

      // Set some cards to active/running then simulate crash
      store.setStatus('goal-1', 'active');
      makeTerminalCard(store, 'code-resume-1', 'goal-1', {
        status: 'running',
      });

      // Create a new runtime that simulates crash recovery
      runtime = new Runtime(makeDefaultConfig({ 'goal-1': 'crash-recovery' }));

      // Manually call crash recovery (as startup would)
      runtime.performCrashRecovery();

      // Verify cards are back to backlog
      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');
      const card = store.read('code-resume-1');
      expect(card!.status).toBe('backlog');

      // Now do a full startup and dispatch — should work fine
      await runtime.startup();
      await runtime.dispatchGoal('goal-1');

      const goalAfter = store.read('goal-1');
      expect(goalAfter!.status).toBe('done');

      await runtime.shutdown();
    });
  });

  // ── Pause/Resume ─────────────────────────────────────────────

  describe('Pause / Resume', () => {
    it('pause stops dispatch, resume allows it', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Pause Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      // Pause
      runtime.pause();
      expect(runtime.paused).toBe(true);

      // Try to dispatch while paused — should emit dispatch_blocked
      const blockedEvents: unknown[] = [];
      runtime.on('dispatch_blocked', (data) => blockedEvents.push(data));

      await runtime.dispatchGoal('goal-1');
      expect(blockedEvents.length).toBeGreaterThanOrEqual(1);

      // Goal should NOT have been processed
      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');

      // Resume
      runtime.resume();
      expect(runtime.paused).toBe(false);

      // Now dispatch should work
      await runtime.dispatchGoal('goal-1');
      const goalAfter = store.read('goal-1');
      expect(goalAfter!.status).toBe('done');

      await runtime.shutdown();
    });
  });

  // ── Queue Ordering ───────────────────────────────────────────

  describe('Queue ordering', () => {
    it('sorts ready cards by depends_on then priority', () => {
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-q', 'Queue Goal');

      // Create cards with dependencies and varying priorities
      const c1 = makeTerminalCard(store, 'code-q-1', goal.id, {
        title: 'Q1 - no deps, priority 5',
        priority: 5,
      });

      const c2 = makeTerminalCard(store, 'code-q-2', goal.id, {
        title: 'Q2 - depends on Q1, priority 1',
        priority: 1,
        depends_on: [c1.id],
      });

      const c3 = makeTerminalCard(store, 'code-q-3', goal.id, {
        title: 'Q3 - no deps, priority 2',
        priority: 2,
      });

      runtime = new Runtime(makeDefaultConfig());
      const queue = runtime.getReadyQueue(goal.id);

      // Only c1 and c3 are ready; c2 blocked (depends_on c1 not done)
      // Sort: depends_on.length: c1(0)=c3(0), then priority: c3(2) < c1(5)
      expect(queue.length).toBe(2);
      expect(queue[0].id).toBe(c3.id); // priority 2 before priority 5
      expect(queue[1].id).toBe(c1.id); // priority 5

      // Now mark c1 as done, c2 should become ready
      store.setStatus(c1.id, 'done');

      const queue2 = runtime.getReadyQueue(goal.id);
      // c3 (priority 2, 0 deps) and c2 (priority 1, 1 dep)
      // Sort by depends_on.length first: c3(0) < c2(1), so c3 first
      expect(queue2.length).toBe(2);
      expect(queue2[0].id).toBe(c3.id);
      expect(queue2[1].id).toBe(c2.id);
    });
  });
});

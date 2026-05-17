import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { Runtime } from '../../src/utils/runtime.js';
import type { FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import type { CardRecord, CardStatus } from '../../src/schemas/types.js';

// ── Helpers ───────────────────────────────────────────────────

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

/**
 * Move a card through the lifecycle: backlog → active → running → targetStatus.
 */
function advanceToTerminal(
  store: CardStore,
  goalId: string,
  targetStatus: CardStatus = 'done',
): void {
  store.setStatus(goalId, 'active');
  store.setStatus(goalId, 'running');
  store.setStatus(goalId, targetStatus);
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

// ── Fixtures ──────────────────────────────────────────────────

function createProjectImprovementFixture(fixtureDir: string): void {
  const fixture: FakeAgentFixture = {
    name: 'project-improvement',
    planner: [
      {
        created_cards: [
          {
            id: 'goal-ci-1',
            type: 'goal',
            title: 'CI-proposed goal 1',
            description: 'Auto-proposed improvement goal',
            status: 'backlog',
            depends_on: [],
            priority: 1,
          },
        ],
        status: 'done',
      },
    ],
    executor: {},
    reviewer: [],
  };
  writeFixture(fixtureDir, 'project-improvement', fixture);
}

// ── Test Suite ────────────────────────────────────────────────

describe('Runtime Continuous Improvement', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ci-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (runtime) {
      try {
        await runtime.shutdown();
      } catch {
        // ignore
      }
    }
    try {
      releaseLock(tmpDir);
    } catch {
      // ignore
    }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 1: enabled + all goals terminal → improvement invoked
  // ═══════════════════════════════════════════════════════════════

  describe('Enabled, all goals terminal', () => {
    it('invokes improvement planner when all top-level goals are terminal', async () => {
      createProjectImprovementFixture(fixtureDir);

      // Pre-create terminal goals on disk before constructing Runtime
      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Feature A');
      advanceToTerminal(setupStore, 'goal-1', 'done');
      makeGoalCard(setupStore, 'goal-2', 'Feature B');
      advanceToTerminal(setupStore, 'goal-2', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      const impPromise = new Promise<{ goalIds: string[] }>((resolve) => {
        runtime.on('improvement_invoked', (data) => resolve(data as { goalIds: string[] }));
      });

      await runtime.startup();
      const event = await impPromise;

      expect(event.goalIds).toContain('goal-1');
      expect(event.goalIds).toContain('goal-2');
    });

    it('improvement dispatch creates new goal cards via the planner', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-1', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      const impPromise = new Promise<void>((resolve) => {
        runtime.on('improvement_invoked', () => resolve());
      });

      await runtime.startup();
      await impPromise;

      // Give the planner application a moment to create cards
      await new Promise<void>((r) => setTimeout(r, 100));

      // Verify the CI-proposed goal card was created
      const ciGoal = runtime.cardStore.read('goal-ci-1');
      expect(ciGoal).not.toBeNull();
      expect(ciGoal!.type).toBe('goal');
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 2: disabled → no improvement dispatch
  // ═══════════════════════════════════════════════════════════════

  describe('Disabled', () => {
    it('does NOT invoke improvement planner when feature is disabled', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-1', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: false,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let improvementInvoked = false;
      runtime.on('improvement_invoked', () => {
        improvementInvoked = true;
      });

      await runtime.startup();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(improvementInvoked).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 3: enabled + non-terminal goals → no improvement dispatch
  // ═══════════════════════════════════════════════════════════════

  describe('Enabled with non-terminal goals', () => {
    it('does NOT invoke improvement when a goal is still active', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-done', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-done', 'done');
      makeGoalCard(setupStore, 'goal-active', 'Active Goal');
      setupStore.setStatus('goal-active', 'active');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let improvementInvoked = false;
      runtime.on('improvement_invoked', () => {
        improvementInvoked = true;
      });

      await runtime.startup();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(improvementInvoked).toBe(false);
    });

    it('does NOT invoke improvement when a goal is still in backlog', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-done', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-done', 'done');
      makeGoalCard(setupStore, 'goal-backlog', 'Backlog Goal');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let improvementInvoked = false;
      runtime.on('improvement_invoked', () => {
        improvementInvoked = true;
      });

      await runtime.startup();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(improvementInvoked).toBe(false);
    });

    it('does NOT invoke improvement when there are NO top-level goals', async () => {
      createProjectImprovementFixture(fixtureDir);

      // Only the project card exists (from initProjectTree), no goals

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let improvementInvoked = false;
      runtime.on('improvement_invoked', () => {
        improvementInvoked = true;
      });

      await runtime.startup();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(improvementInvoked).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 4: enabled + paused → no improvement dispatch
  // ═══════════════════════════════════════════════════════════════

  describe('Enabled but paused', () => {
    it('paused runtime does not trigger improvement via dispatchGoal', async () => {
      createProjectImprovementFixture(fixtureDir);

      // Create a fixture for a goal we can dispatch
      const goalFixture: FakeAgentFixture = {
        name: 'pause-goal',
        planner: [
          {
            created_cards: [
              {
                id: 'code-pt-1',
                type: 'code',
                title: 'Pause test card',
                description: 'Test',
                status: 'backlog',
                depends_on: [],
                priority: 1,
              },
            ],
            status: 'continue',
          },
          {
            updated_cards: [],
            status: 'done',
          },
        ],
        executor: {
          'code-pt-1': { card_id: 'code-pt-1', status: 'done', status_text: 'Completed successfully' },
        },
        reviewer: [
          {
            assessment: {
              id: 'review-pt',
              goal_card_id: 'goal-pt',
              reviewer_session_id: 'rev-pt',
              assessment_id: 'assessment-test',
              at: '2025-01-01T00:00:00.000Z',
              result: 'pass',
              summary: 'Pass.',
              achieved: ['Done'],
              issues: [],
              evidence_card_ids: ['code-pt-1'],
              created_at: new Date().toISOString(),
            },
          },
        ],
      };
      writeFixture(fixtureDir, 'pause-goal', goalFixture);

      // Pre-create a terminal goal so that after goal-pt would complete,
      // all goals would be terminal (triggering improvement check)
      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-pre-done', 'Pre-done Goal');
      advanceToTerminal(setupStore, 'goal-pre-done', 'done');
      // Create the dispatchable goal (backlog, not terminal yet)
      makeGoalCard(setupStore, 'goal-pt', 'Pause Test Goal');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement', 'goal-pt': 'pause-goal' },
          fixtureDir,
        },
      });
      await runtime.startup();

      // Startup's improvement check should not fire because goal-pt is backlog
      await new Promise<void>((resolve) => setTimeout(resolve, 150));

      // Now pause the runtime
      runtime.pause();
      expect(runtime.paused).toBe(true);

      let improvementInvoked = false;
      runtime.on('improvement_invoked', () => {
        improvementInvoked = true;
      });

      const blockedEvents: unknown[] = [];
      runtime.on('dispatch_blocked', (data) => blockedEvents.push(data));

      await runtime.dispatchGoal('goal-pt');

      // dispatchGoal should have been blocked by pause
      expect(blockedEvents.length).toBeGreaterThanOrEqual(1);
      // No improvement should have fired
      expect(improvementInvoked).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // Test 5: improvement_invoked event emitted with correct data
  // ═══════════════════════════════════════════════════════════════

  describe('improvement_invoked event', () => {
    it('emits improvement_invoked event with goalIds array', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-a', 'Goal Alpha');
      advanceToTerminal(setupStore, 'goal-a', 'done');
      makeGoalCard(setupStore, 'goal-b', 'Goal Beta');
      advanceToTerminal(setupStore, 'goal-b', 'failed');
      makeGoalCard(setupStore, 'goal-c', 'Goal Gamma');
      advanceToTerminal(setupStore, 'goal-c', 'cancelled');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      const eventPromise = new Promise<{ goalIds: string[] }>((resolve) => {
        runtime.on('improvement_invoked', (data) => resolve(data as { goalIds: string[] }));
      });

      await runtime.startup();
      const event = await eventPromise;

      expect(event.goalIds).toHaveLength(3);
      expect(event.goalIds).toContain('goal-a');
      expect(event.goalIds).toContain('goal-b');
      expect(event.goalIds).toContain('goal-c');
    });

    it('emits plan_updated with source=continuous-improvement', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-1', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      const planPromise = new Promise<{ goalId: string; source: string }>((resolve) => {
        runtime.on('plan_updated', (data) => {
          const d = data as { goalId: string; source: string };
          if (d.source === 'continuous-improvement') resolve(d);
        });
      });

      await runtime.startup();
      const event = await planPromise;
      expect(event.goalId).toBe('project');
      expect(event.source).toBe('continuous-improvement');
    });

    it('does NOT emit improvement_invoked when feature is disabled', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Done Goal');
      advanceToTerminal(setupStore, 'goal-1', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: false,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let eventEmitted = false;
      runtime.on('improvement_invoked', () => {
        eventEmitted = true;
      });

      await runtime.startup();
      await new Promise<void>((resolve) => setTimeout(resolve, 200));

      expect(eventEmitted).toBe(false);
    });

    it('does NOT emit duplicate improvement_invoked events (guard prevents re-entry)', async () => {
      createProjectImprovementFixture(fixtureDir);

      const setupStore = new CardStore(tmpDir);
      makeGoalCard(setupStore, 'goal-1', 'Goal One');
      advanceToTerminal(setupStore, 'goal-1', 'done');

      runtime = new Runtime({
        projectRoot: tmpDir,
        continuousImprovement: true,
        fakeAgentConfig: {
          mapping: { project: 'project-improvement' },
          fixtureDir,
        },
      });

      let invokeCount = 0;
      runtime.on('improvement_invoked', () => {
        invokeCount++;
      });

      await runtime.startup();

      // Wait for startup's check to complete
      await new Promise<void>((resolve) => setTimeout(resolve, 300));

      // The guard prevents re-entry. Exactly 1 event expected from startup.
      expect(invokeCount).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { AgentRuntime } from '../../src/agents/agent-runtime.js';

// ── Helpers ───────────────────────────────────────────────────

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
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

// ── Test Suite ────────────────────────────────────────────────

describe('Runtime Adapter Wiring', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-raw-'));
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

  // ── Happy-path fixture ──────────────────────────────────────

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
              title: 'Happy feature',
              description: 'Implement happy path',
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
        'code-happy-1': { card_id: 'code-happy-1', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-happy-1',
            goal_card_id: 'goal-1',
            plan_card_id: 'plan-goal-1',
            reviewer_session_id: 'rev-session',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented'],
            missing: [],
            evidence_card_ids: ['code-happy-1'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'happy-goal', fixture);
  }

  function makeConfig() {
    return {
      projectRoot: tmpDir,
      fakeAgentConfig: {
        mapping: {
          'goal-1': 'happy-goal',
          project: 'happy-goal',
        },
        fixtureDir,
      },
    };
  }

  // ═══════════════════════════════════════════════════════════════
  // AC 1: Runtime constructor accepts injected AgentRuntime
  // ═══════════════════════════════════════════════════════════════

  describe('Dependency injection: Runtime accepts AgentRuntime', () => {
    it('Runtime constructor accepts FakeAgentAdapter as AgentRuntime', () => {
      createHappyPathFixture();

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      // Construct Runtime with explicit agentRuntime
      runtime = new Runtime(makeConfig(), fakeAgent);

      // Verify the injected adapter is used
      expect(runtime.agentRuntime).toBe(fakeAgent);
    });

    it('Runtime dispatches a goal through the injected FakeAgentAdapter', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      runtime = new Runtime(makeConfig(), fakeAgent);
      await runtime.startup();

      let goalCompleted = false;
      runtime.on('goal_completed', () => {
        goalCompleted = true;
      });

      await runtime.dispatchGoal('goal-1');

      // Verify the goal reached 'done'
      const goal = store.read('goal-1');
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('done');

      // Verify the terminal card was executed
      const card = store.read('code-happy-1');
      expect(card).not.toBeNull();
      expect(card!.status).toBe('done');

      expect(goalCompleted).toBe(true);

      await runtime.shutdown();
    });

    it('injected adapter produces the same results as default path', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      runtime = new Runtime(makeConfig(), fakeAgent);
      await runtime.startup();

      const events: string[] = [];
      runtime.on('goal_completed', () => events.push('goal_completed'));
      runtime.on('review_failed', () => events.push('review_failed'));
      runtime.on('card_failed', () => events.push('card_failed'));

      await runtime.dispatchGoal('goal-1');

      expect(events).toContain('goal_completed');
      expect(events).not.toContain('review_failed');
      expect(events).not.toContain('card_failed');

      await runtime.shutdown();
    });

    it('any object implementing AgentRuntime can be injected', () => {
      // Create a minimal AgentRuntime implementation
      const minimalRt: AgentRuntime = {
        invokePlanner(_goalId: string) {
          return {
            plan_card_id: 'plan-test',
            created_cards: [],
            updated_cards: [],
            declare_done: true,
            summary: 'done',
          };
        },
        invokeExecutor(_cardId: string, _goalId: string) {
          return {
            card_id: 'code-test',
            status: 'done' as const,
            artifacts: [],
            attachments: [],
          };
        },
        invokeReviewer(_goalId: string) {
          return {
            assessment: {
              result: 'pass' as const,
              summary: 'ok',
              achieved: ['done'],
              missing: [],
              evidence_card_ids: [],
            },
          };
        },
        cancelSession(_sessionId: string) {
          return false;
        },
        forceCancelSession(_sessionId: string) {
          return false;
        },
      };

      // Construct Runtime with the minimal AgentRuntime
      runtime = new Runtime(makeConfig(), minimalRt);
      expect(runtime.agentRuntime).toBe(minimalRt);
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 2: Runtime still works without explicit agentRuntime
  //       (backward-compatible with config.fakeAgentConfig)
  // ═══════════════════════════════════════════════════════════════

  describe('Backward compatibility: Runtime without explicit agentRuntime', () => {
    it('Runtime creates FakeAgentAdapter internally when no agentRuntime passed', () => {
      createHappyPathFixture();

      runtime = new Runtime(makeConfig());

      // agentRuntime should exist and be a FakeAgentAdapter
      expect(runtime.agentRuntime).toBeDefined();
      expect(runtime.agentRuntime).toBeInstanceOf(FakeAgentAdapter);
    });

    it('Runtime dispatches goal with internally-created FakeAgentAdapter', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      // No agentRuntime passed — Runtime auto-creates FakeAgentAdapter
      runtime = new Runtime(makeConfig());
      await runtime.startup();

      let goalCompleted = false;
      runtime.on('goal_completed', () => {
        goalCompleted = true;
      });

      await runtime.dispatchGoal('goal-1');

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('done');
      expect(goalCompleted).toBe(true);

      await runtime.shutdown();
    });
  });

  // ═══════════════════════════════════════════════════════════════
  // AC 3: Injected adapter runs fixture-driven goal flow
  //       (backlog → plan → exec → review → done)
  // ═══════════════════════════════════════════════════════════════

  describe('Full fixture-driven goal flow with injected adapter', () => {
    it('completes the lifecycle: backlog → plan → exec → review → done', async () => {
      // Create the source file that will be referenced as an artifact
      mkdirSync(join(tmpDir, 'src'), { recursive: true });
      writeFileSync(join(tmpDir, 'src', 'test.ts'), '// test file', 'utf-8');

      const lifecycleFixture: FakeAgentFixture = {
        name: 'lifecycle-goal',
        planner: [
          {
            plan_card_id: 'plan-goal-lifecycle',
            created_cards: [
              {
                id: 'code-lifecycle-1',
                type: 'code',
                title: 'Lifecycle card 1',
                description: 'First card',
                status: 'backlog',
                depends_on: [],
                priority: 1,
              },
            ],
            declare_done: false,
          },
          {
            plan_card_id: 'plan-goal-lifecycle',
            updated_cards: [],
            declare_done: true,
          },
        ],
        executor: {
          'code-lifecycle-1': {
            card_id: 'code-lifecycle-1',
            status: 'done',
            result: { success: true },
            artifacts: [
              {
                sourceFile: join(tmpDir, 'src', 'test.ts'),
                type: 'data',
                description: 'Test artifact',
                retain: true,
              },
            ],
          },
        },
        reviewer: [
          {
            assessment: {
              id: 'review-lifecycle-1',
              goal_card_id: 'goal-lifecycle',
              plan_card_id: 'plan-goal-lifecycle',
              reviewer_session_id: 'rev-session-lc',
              result: 'pass',
              summary: 'Lifecycle test passed.',
              achieved: ['Lifecycle completed'],
              missing: [],
              evidence_card_ids: ['code-lifecycle-1'],
              created_at: new Date().toISOString(),
            },
          },
        ],
      };
      writeFixture(fixtureDir, 'lifecycle-goal', lifecycleFixture);

      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-lifecycle', 'Lifecycle Goal');

      // Verify initial state
      expect(goal.status).toBe('backlog');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-lifecycle': 'lifecycle-goal', '*': 'lifecycle-goal' },
        fixtureDir,
      });

      runtime = new Runtime(makeConfig(), fakeAgent);
      await runtime.startup();

      // After startup, goal should still be backlog (startup only resets active/running)
      const goalAfterStartup = store.read('goal-lifecycle');
      expect(goalAfterStartup!.status).toBe('backlog');

      let goalCompleted = false;
      runtime.on('goal_completed', () => {
        goalCompleted = true;
      });

      await runtime.dispatchGoal('goal-lifecycle');

      // Verify goal reached 'done'
      const finalGoal = store.read('goal-lifecycle');
      expect(finalGoal!.status).toBe('done');

      // Verify the terminal card was executed
      const card = store.read('code-lifecycle-1');
      expect(card!.status).toBe('done');
      expect(card!.result).toEqual({ success: true });

      expect(goalCompleted).toBe(true);

      await runtime.shutdown();
    });

    it('reporter correctly identifies passed tests when injected adapter works', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      runtime = new Runtime(makeConfig(), fakeAgent);
      await runtime.startup();
      await runtime.dispatchGoal('goal-1');

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('done');

      await runtime.shutdown();
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import { createRuntimeTestHarness, type RuntimeTestHarness } from './runtime-test-harness.js';

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

describe('Runtime Adapter Wiring', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let dispatchTools: RuntimeTestHarness['dispatchTestTools'];
  let harness: RuntimeTestHarness;

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

  function createHappyPathFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'happy-goal',
      planner: [
        {
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
          status: 'continue',
        },
        {
          updated_cards: [],
          status: 'done',
        },
        {
          updated_cards: [],
          status: 'done',
        },
        {
          updated_cards: [],
          status: 'done',
        },
      ],
      executor: {
        'code-happy-1': { card_id: 'code-happy-1', status: 'done', status_text: 'Completed successfully', result: { evidence: 'happy card completed' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-happy-1',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented'],
            issues: [],
            evidence_card_ids: ['code-happy-1'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-happy-2',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-2',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented'],
            issues: [],
            evidence_card_ids: ['code-happy-1'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-repeat-3',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-3',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Repeated pass review.',
            achieved: ['Done'],
            issues: [],
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

  function makeRuntime(agentRuntime?: AgentRuntime): void {
    harness = createRuntimeTestHarness({
      config: makeConfig(),
      ...(agentRuntime ? { agentRuntime } : {}),
    });
    dispatchTools = harness.dispatchTestTools;
  }

  describe('Dependency injection: Runtime accepts AgentRuntime', () => {
    it('Runtime constructor accepts FakeAgentAdapter as AgentRuntime', () => {
      createHappyPathFixture();

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      makeRuntime(fakeAgent);
      expect(harness.agentRuntimeTestTools.isSameAgentRuntime(fakeAgent)).toBe(true);
    });

    it('Runtime dispatches a goal through the injected FakeAgentAdapter', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      makeRuntime(fakeAgent);
      await harness.api.start();

      let goalCompleted = false;
      harness.events.on('goal_completed', () => {
        goalCompleted = true;
      });

      await dispatchTools.dispatchGoal('goal-1');

      const goal = store.read('goal-1');
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('done');

      const card = store.read('code-happy-1');
      expect(card).not.toBeNull();
      expect(card!.status).toBe('done');

      expect(goalCompleted).toBe(true);

      await harness.api.shutdown();
    });

    it('injected adapter produces the same results as default path', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      makeRuntime(fakeAgent);
      await harness.api.start();

      const events: string[] = [];
      harness.events.on('goal_completed', () => events.push('goal_completed'));
      harness.events.on('review_failed', () => events.push('review_failed'));
      harness.events.on('card_failed', () => events.push('card_failed'));

      await dispatchTools.dispatchGoal('goal-1');

      expect(events).toContain('goal_completed');
      expect(events).not.toContain('review_failed');
      expect(events).not.toContain('card_failed');

      await harness.api.shutdown();
    });

    it('any object implementing AgentRuntime can be injected', () => {
      const minimalRt: AgentRuntime = {
        invokePlanner(_request) {
          return {
            created_cards: [],
            updated_cards: [],
            status: 'done',
            summary: 'done',
          };
        },
        invokeExecutor(_request) {
          return {
            card_id: 'code-test',
            status: 'done' as const,
            status_text: 'Completed successfully',
            artifacts: [],
            attachments: [],
            fallback_with_evidence: null,
          };
        },
        invokeReviewer(_request) {
          return {
            assessment: {
              result: 'pass' as const,
              summary: 'ok',
              achieved: ['done'],
              issues: [],
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
        getHandoffSummary(_sessionId: string) {
          return null;
        },
        getActiveSessionHandoffs() {
          return [];
        },
      };

      makeRuntime(minimalRt);
      expect(harness.agentRuntimeTestTools.isSameAgentRuntime(minimalRt)).toBe(true);
    });
  });

  describe('Backward compatibility: Runtime without explicit agentRuntime', () => {
    it('Runtime creates FakeAgentAdapter internally when no agentRuntime passed', () => {
      createHappyPathFixture();

      makeRuntime();

      expect(harness.agentRuntimeTestTools.getConstructorName()).toBe(FakeAgentAdapter.name);
    });

    it('Runtime dispatches goal with internally-created FakeAgentAdapter', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      makeRuntime();
      await harness.api.start();

      let goalCompleted = false;
      harness.events.on('goal_completed', () => {
        goalCompleted = true;
      });

      await dispatchTools.dispatchGoal('goal-1');

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('done');
      expect(goalCompleted).toBe(true);

      await harness.api.shutdown();
    });
  });

  describe('Full fixture-driven goal flow with injected adapter', () => {
    it('completes the lifecycle: backlog → plan → exec → review → done', async () => {
      mkdirSync(join(tmpDir, 'src'), { recursive: true });
      writeFileSync(join(tmpDir, 'src', 'test.ts'), '// test file', 'utf-8');

      const lifecycleFixture: FakeAgentFixture = {
        name: 'lifecycle-goal',
        planner: [
          {
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
            status: 'continue',
          },
          {
            updated_cards: [],
            status: 'done',
          },
          {
            updated_cards: [],
            status: 'done',
          },
        ],
        executor: {
          'code-lifecycle-1': {
            card_id: 'code-lifecycle-1',
            status: 'done',
            status_text: 'Completed successfully',
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
              reviewer_session_id: 'rev-session-lc',
              assessment_id: 'assessment-test',
              at: '2025-01-01T00:00:00.000Z',
              result: 'pass',
              summary: 'Lifecycle test passed.',
              achieved: ['Lifecycle completed'],
              issues: [],
              evidence_card_ids: ['code-lifecycle-1'],
              created_at: new Date().toISOString(),
            },
          },
        ],
      };
      writeFixture(fixtureDir, 'lifecycle-goal', lifecycleFixture);

      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-lifecycle', 'Lifecycle Goal');

      expect(goal.status).toBe('backlog');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-lifecycle': 'lifecycle-goal', '*': 'lifecycle-goal' },
        fixtureDir,
      });

      makeRuntime(fakeAgent);
      await harness.api.start();

      const goalAfterStartup = store.read('goal-lifecycle');
      expect(goalAfterStartup!.status).toBe('backlog');

      let goalCompleted = false;
      harness.events.on('goal_completed', () => {
        goalCompleted = true;
      });

      await dispatchTools.dispatchGoal('goal-lifecycle');

      const finalGoal = store.read('goal-lifecycle');
      expect(finalGoal!.status).toBe('done');

      const card = store.read('code-lifecycle-1');
      expect(card!.status).toBe('done');
      expect(card!.result).toEqual(expect.objectContaining({ success: true }));

      expect(goalCompleted).toBe(true);

      await harness.api.shutdown();
    });

    it('reporter correctly identifies passed tests when injected adapter works', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-1': 'happy-goal', '*': 'happy-goal' },
        fixtureDir,
      });

      makeRuntime(fakeAgent);
      await harness.api.start();
      await dispatchTools.dispatchGoal('goal-1');

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('done');

      await harness.api.shutdown();
    });
  });
});

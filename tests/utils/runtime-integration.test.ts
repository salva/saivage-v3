import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, rmSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { readRuntimeState } from '../../src/runtime/state.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import type { FakeAgentFixture } from '../../src/agents/fake-agent.js';
import {
  acquireLock,
  releaseLock,
  isLocked,
  removeStaleLock,
} from '../../src/runtime/lock.js';
import type { CardRecord } from '../../src/schemas/types.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

// ── Helpers ───────────────────────────────────────────────────

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ── Test Suite ────────────────────────────────────────────────

describe('Runtime Integration', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let dispatchTools: RuntimeCoreTestContainer['dispatchTestTools'];
  let harness: RuntimeCoreTestContainer;

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
          status: 'done',
          summary: 'Planner completed after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
      ],
      executor: {
        'code-happy-1': { card_id: 'code-happy-1', status: 'done', status_text: 'Happy feature implemented', result: { evidence: 'happy feature implemented' } },
        'code-happy-2': { card_id: 'code-happy-2', status: 'done', status_text: 'Happy feature tests added', result: { evidence: 'happy feature tests added' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-001',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-1',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented', 'Tests passing'],
            issues: [],
            evidence_card_ids: ['code-happy-1', 'code-happy-2'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-002',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-1',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All acceptance criteria met.',
            achieved: ['Happy path implemented', 'Tests passing'],
            issues: [],
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
          status: 'done',
          summary: 'Planner completed after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
          summary: 'Correction already exists from direct setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
      ],
      executor: {
        'code-rf-1': { card_id: 'code-rf-1', status: 'done', status_text: 'Initial implementation completed', result: { evidence: 'initial implementation completed' } },
        'code-rf-2': { card_id: 'code-rf-2', status: 'done', status_text: 'Review correction completed', result: { evidence: 'review correction completed' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-rf-001',
            goal_card_id: 'goal-2',
            reviewer_session_id: 'rev-session-2',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'needs_corrections',
            summary: 'Missing edge case handling.',
            achieved: ['Basic implementation done'],
            issues: [{ summary: 'Edge case handling', severity: 'blocker' }, { summary: 'Error logging', severity: 'blocker' }],
            evidence_card_ids: ['code-rf-1'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-rf-002',
            goal_card_id: 'goal-2',
            reviewer_session_id: 'rev-session-2',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All criteria met after corrections.',
            achieved: ['Edge case handling', 'Error logging', 'Basic implementation'],
            issues: [],
            evidence_card_ids: ['code-rf-1', 'code-rf-2'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-rf-003',
            goal_card_id: 'goal-2',
            reviewer_session_id: 'rev-session-2',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'All criteria met after corrections.',
            achieved: ['Edge case handling', 'Error logging', 'Basic implementation'],
            issues: [],
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
          status: 'continue',
          summary: 'Planner continued after direct card setup.',
        },
        {
          status: 'done',
          summary: 'Replacement already exists from direct setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
      ],
      executor: {
        'code-ef-1': { card_id: 'code-ef-1', status: 'failed', status_text: 'Build failed', error: 'Build error' },
        'code-ef-2': { card_id: 'code-ef-2', status: 'done', status_text: 'Replacement implementation completed', result: { evidence: 'replacement implementation completed' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-ef-001',
            goal_card_id: 'goal-3',
            reviewer_session_id: 'rev-session-3',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Replacement works.',
            achieved: ['Replacement implemented'],
            issues: [],
            evidence_card_ids: ['code-ef-2'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-ef-002',
            goal_card_id: 'goal-3',
            reviewer_session_id: 'rev-session-3',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Replacement works.',
            achieved: ['Replacement implemented'],
            issues: [],
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
          status: 'done',
          summary: 'Planner completed after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
      ],
      executor: {
        'code-resume-1': { card_id: 'code-resume-1', status: 'done', status_text: 'Crash recovery execution completed', result: { evidence: 'crash recovery execution completed' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-cr-001',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-cr',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Crash recovery test passed.',
            achieved: ['Goal completed after crash'],
            issues: [],
            evidence_card_ids: ['code-resume-1'],
            created_at: new Date().toISOString(),
          },
        },
        {
          assessment: {
            id: 'review-cr-002',
            goal_card_id: 'goal-1',
            reviewer_session_id: 'rev-session-cr',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Crash recovery test passed.',
            achieved: ['Goal completed after crash'],
            issues: [],
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

  function createPlannerPlanCardFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'planner-plan-card-goal',
      planner: [
        {
          status: 'done',
          summary: 'Research cards are prepared directly by the test.',
        },
        {
          status: 'done',
          summary: 'Research is complete.',
        },
        {
          status: 'done',
          summary: 'Research is complete.',
        },
        {
          status: 'done',
          summary: 'Research is complete.',
        },
      ],
      executor: {
        'research-plan-card-1': { card_id: 'research-plan-card-1', status: 'done', status_text: 'Completed successfully', result: { evidence: 'context inspected' } },
        'research-plan-card-2': { card_id: 'research-plan-card-2', status: 'done', status_text: 'Completed successfully', result: { evidence: 'next implementation step defined' } },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-plan-card-001',
            goal_card_id: 'goal-plan-card',
            reviewer_session_id: 'rev-plan-card',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Goal completed.',
            achieved: ['Research completed', 'Next implementation step defined'],
            issues: [],
            evidence_card_ids: ['research-plan-card-1', 'research-plan-card-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'planner-plan-card-goal', fixture);
  }

  function createBlockedPlannerFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'blocked-planner-goal',
      planner: [
        {
          status: 'blocked',
          blocked_reason: 'Needs parent planner to choose a different strategy.',
          summary: 'No viable local next step.',
        },
      ],
      executor: {},
      reviewer: [],
    };
    writeFixture(fixtureDir, 'blocked-planner-goal', fixture);
  }

  function createPlannerMarksGoalDoneFixture(goalId = 'goal-planner-done'): void {
    const fixture: FakeAgentFixture = {
      name: 'planner-marks-goal-done',
      planner: [
        {
          status: 'done',
          summary: 'Goal acceptance is already satisfied.',
        },
        {
          status: 'done',
          summary: 'Goal remains satisfied after reviewer correction.',
        },
      ],
      reviewer: [
        {
          assessment: {
            id: 'review-planner-done-001',
            goal_card_id: goalId,
            reviewer_session_id: 'rev-planner-done',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Goal completed.',
            achieved: ['Goal done'],
            issues: [],
            evidence_card_ids: [goalId],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };
    writeFixture(fixtureDir, 'planner-marks-goal-done', fixture);
  }

  function makeDefaultConfig(overrides?: Record<string, string>) {
    const mapping: Record<string, string> = {
      'goal-1': 'happy-goal',
      'goal-2': 'review-fail-goal',
      'goal-3': 'exec-fail-goal',
      'goal-plan-card': 'planner-plan-card-goal',
      'goal-blocked': 'blocked-planner-goal',
      'goal-planner-done': 'planner-marks-goal-done',
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

  function makeRuntime(input?: { overrides?: Record<string, string>; agentRuntime?: FakeAgentAdapter; autoDispatchBacklog?: boolean }): void {
    harness = createRuntimeCoreTestContainer({
      config: {
        ...makeDefaultConfig(input?.overrides),
        ...(input?.autoDispatchBacklog !== undefined ? { autoDispatchBacklog: input.autoDispatchBacklog } : {}),
      },
      ...(input?.agentRuntime ? { agentRuntime: input.agentRuntime } : {}),
    });
    dispatchTools = harness.dispatchTestTools;
  }

  function makeGoalCard(store: CardStore, id: string, title: string): CardRecord {
    return store.create({
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

  describe('AC 1: Full goal flow (backlog → done)', () => {
    it('does not start backlog root work from status-only startup', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-1', 'Happy Goal');

      makeRuntime({ autoDispatchBacklog: true });

      await harness.api.start();
      await new Promise((resolve) => setTimeout(resolve, 25));

      expect(store.read(goal.id)?.status).toBe('backlog');
      expect(store.read('code-happy-1')).toBeNull();
      expect(store.read('code-happy-2')).toBeNull();

      await harness.api.shutdown();
    });

  });


  describe('Stage 3 executor status_text mirroring', () => {


  });

  describe('Planner goal-owned planning contract', () => {
    it('allows blocked goals to be reopened to backlog for replanning', () => {
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-reopen', 'Reopen Blocked Goal');
      store.setStatus(goal.id, 'active');
      store.setStatus(goal.id, 'running');
      store.repairTerminalLifecycle(goal.id, {
        status: 'blocked',
        lifecycle: { status: 'blocked', result: { kind: 'planner_blocked', blocked_reason: 'blocked', resume_reason: 'planner_blocked' }, error: 'blocked', completed_at: null },
      });

      store.setStatus(goal.id, 'backlog');

      expect(store.read(goal.id)!.status).toBe('backlog');
    });


    it('marks a goal blocked when the planner returns blocked', async () => {
      createBlockedPlannerFixture();
      const store = new CardStore(tmpDir);
      const goalCard = makeGoalCard(store, 'goal-blocked', 'Blocked Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { [goalCard.id]: 'blocked-planner-goal' },
        fixtureDir,
      });
      makeRuntime({ overrides: { [goalCard.id]: 'blocked-planner-goal' }, agentRuntime: fakeAgent });
      await harness.api.start();
      await dispatchTools.dispatchGoal(goalCard.id);

      const goal = store.read(goalCard.id);
      expect(goal!.status).toBe('blocked');
      expect(goal!.lifecycle.result).toMatchObject({
        kind: 'planner_blocked',
        blocked_reason: 'Needs parent planner to choose a different strategy.',
      });
      expect(fakeAgent.getPlannerCount(goalCard.id)).toBe(1);

      await harness.api.shutdown();
    });

    it('idles persisted runtime state when planner already marked reviewed goal done', async () => {
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-planner-done', 'Planner Done Goal');
      createPlannerMarksGoalDoneFixture(goal.id);
      store.update(goal.id, {
        artifacts: [{ id: 'artifact-goal-planner-done', card_id: goal.id, path: 'reports/goal-planner-done.md', type: 'report', description: 'review evidence', retain: true, created_at: new Date().toISOString() }],
      });

      makeRuntime({ overrides: { [goal.id]: 'planner-marks-goal-done' } });
      await harness.api.start();

      const completedEvents: string[] = [];
      harness.eventTestTools.on('goal_completed', () => completedEvents.push('goal_completed'));

      await dispatchTools.dispatchGoal(goal.id);

      expect(store.read(goal.id)!.status).toBe('done');
      expect(completedEvents).toContain('goal_completed');
      expect(readRuntimeState(tmpDir)).toMatchObject({
        status: 'idle',
        current_card_id: null,
        current_agent_session_id: null,
      });

      await harness.api.shutdown();
    });
  });

  describe('AC 2: Reviewer failure → planner re-invoked → correction cards', () => {

  });

  describe('AC 3: Failed terminal card re-invokes parent planner', () => {
  });

  describe('AC 4: Exclusive lock — second instance rejected', () => {
    it('prevents second instance from acquiring lock while first is alive', () => {
      createLockFixture();

      const payload1 = acquireLock(tmpDir);
      expect(payload1.pid).toBe(process.pid);
      expect(isLocked(tmpDir)).toBe(true);

      expect(() => acquireLock(tmpDir)).toThrow(/Cannot acquire lock/);

      releaseLock(tmpDir);
      expect(isLocked(tmpDir)).toBe(false);

      const payload2 = acquireLock(tmpDir);
      expect(payload2.pid).toBe(process.pid);
      releaseLock(tmpDir);
    });
  });

  describe('AC 5: Stale lock detection', () => {
    it('removes lock when PID is dead', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });
      const deadPayload = { pid: 99999, started_at: new Date().toISOString() };
      writeFileSync(lockPath, JSON.stringify(deadPayload, null, 2), 'utf-8');

      expect(() => acquireLock(tmpDir)).not.toThrow();

      releaseLock(tmpDir);
    });

    it('removes lock when older than configured maxAge', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });

      const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
      const oldPayload = { pid: process.pid, started_at: oldDate };
      writeFileSync(lockPath, JSON.stringify(oldPayload, null, 2), 'utf-8');

      expect(() => acquireLock(tmpDir)).not.toThrow();

      releaseLock(tmpDir);
    });

    it('removeStaleLock only removes when PID is dead or age exceeds bound', () => {
      createLockFixture();

      const lockPath = join(tmpDir, '.saivage-work', 'tmp', 'runtime', 'runtime.lock');
      mkdirSync(join(tmpDir, '.saivage-work', 'tmp', 'runtime'), { recursive: true });

      const freshPayload = { pid: process.pid, started_at: new Date().toISOString() };
      writeFileSync(lockPath, JSON.stringify(freshPayload, null, 2), 'utf-8');
      expect(existsSync(lockPath)).toBe(true);

      removeStaleLock(tmpDir);
      expect(existsSync(lockPath)).toBe(true);

      releaseLock(tmpDir);

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

      removeStaleLock(tmpDir);
      expect(isLocked(tmpDir)).toBe(true);

      releaseLock(tmpDir);
    });
  });

  describe('AC 6: Crash recovery', () => {
    it('resets active and running cards to backlog after crash', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      const goalCard = makeGoalCard(store, 'goal-1', 'Crash Goal');

      store.setStatus(goalCard.id, 'active');
      const terminalCard = makeTerminalCard(store, 'code-crash-1', goalCard.id, {
        status: 'running',
      });

      makeRuntime();
      await harness.lifecycleTestTools.performCrashRecovery();

      const goal = store.read(goalCard.id);
      expect(goal!.status).toBe('backlog');

      const card = store.read(terminalCard.id);
      expect(card!.status).toBe('backlog');
    });

  });

  describe('Pause / Resume', () => {
  });

  describe('Activation-gated child dispatch', () => {
    it('keeps status-only backlog children as planner metadata until explicitly activated', () => {
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-q', 'Activation Goal');

      const q1 = makeTerminalCard(store, 'code-q-1', goal.id, {
        title: 'Q1 - no deps, priority 5',
        priority: 5,
      });
      const q2 = makeTerminalCard(store, 'code-q-2', goal.id, {
        title: 'Q2 - no deps, priority 1',
        priority: 1,
      });

      makeRuntime();

      expect(harness.stateTestTools.read()?.runtime_activations ?? []).toEqual([]);
      expect(store.read(q1.id)!.status).toBe('backlog');
      expect(store.read(q2.id)!.status).toBe('backlog');
    });
  });

  describe('AC 7: Goal with per-goal instructions_file dispatch', () => {


  });
});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, rmSync, mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import Fastify from 'fastify';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { Runtime } from '../../src/utils/runtime.js';
import { readRuntimeState } from '../../src/utils/runtime-state.js';
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
          status: 'done',
        },
        {
          updated_cards: [],
          status: 'done',
        },
        {
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
          status: 'continue',
        },
        {
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
          created_cards: [
            {
              id: 'research-plan-card-1',
              type: 'research',
              title: 'Inspect context',
              description: 'Inspect the current goal context',
              status: 'backlog',
              depends_on: [],
              priority: 0,
            },
            {
              id: 'research-plan-card-2',
              type: 'research',
              title: 'Define next executable implementation step',
              description: 'Define the next implementation step',
              status: 'backlog',
              depends_on: ['research-plan-card-1'],
              priority: 1,
            },
          ],
          summary: 'Created two research cards.',
        },
        {
          updated_cards: [],
          status: 'done',
          summary: 'Research is complete.',
        },
        {
          updated_cards: [],
          status: 'done',
          summary: 'Research is complete.',
        },
        {
          updated_cards: [],
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
          created_cards: [],
          updated_cards: [],
          summary: 'No viable local next step.',
        },
      ],
      executor: {},
      reviewer: [],
    };
    writeFixture(fixtureDir, 'blocked-planner-goal', fixture);
  }

  function createPlannerMarksGoalDoneFixture(): void {
    const fixture: FakeAgentFixture = {
      name: 'planner-marks-goal-done',
      planner: [
        {
          status: 'done',
          updated_cards: [
            { id: 'goal-planner-done', status: 'done' },
          ],
          summary: 'Goal acceptance is already satisfied.',
        },
      ],
      reviewer: [
        {
          assessment: {
            id: 'review-planner-done-001',
            goal_card_id: 'goal-planner-done',
            reviewer_session_id: 'rev-planner-done',
            assessment_id: 'assessment-test',
            at: '2025-01-01T00:00:00.000Z',
            result: 'pass',
            summary: 'Goal completed.',
            achieved: ['Goal done'],
            issues: [],
            evidence_card_ids: ['goal-planner-done'],
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

  describe('AC 1: Full goal flow (backlog → done)', () => {
    it('auto-dispatches the first backlog top-level goal on startup when enabled', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      runtime = new Runtime({
        ...makeDefaultConfig(),
        autoDispatchBacklog: true,
      });

      await runtime.startup();
      await waitFor(() => store.read('goal-1')?.status === 'done');

      expect(store.read('code-happy-1')?.status).toBe('done');
      expect(store.read('code-happy-2')?.status).toBe('done');

      await runtime.shutdown();
    });

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

      const goal = store.read('goal-1');
      expect(goal).not.toBeNull();
      expect(goal!.status).toBe('done');

      const card1 = store.read('code-happy-1');
      expect(card1).not.toBeNull();
      expect(card1!.status).toBe('done');

      const card2 = store.read('code-happy-2');
      expect(card2).not.toBeNull();
      expect(card2!.status).toBe('done');

      expect(events).not.toContain('card_failed');
      expect(events).not.toContain('review_failed');
      expect(events).toContain('goal_completed');

      await runtime.shutdown();
    });
  });


  describe('Stage 3 executor status_text mirroring', () => {
    it('persists terminal executor status_text metadata and latest_self_report on the card', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();
      await runtime.dispatchGoal('goal-1');

      const card = store.read('code-happy-1')!;
      expect(card.status).toBe('done');
      expect(card.status_text).toBe('Happy feature implemented');
      expect(card.status_text_updated_at).toEqual(expect.any(String));
      expect(Number.isNaN(Date.parse(card.status_text_updated_at!))).toBe(false);
      expect(card.status_text_author_session_id).toMatch(/^fake-executor-/);
      expect(card.latest_self_report).toEqual(expect.objectContaining({
        result: 'done',
        outcome: 'done',
        summary: 'Happy feature implemented',
        status_text: 'Happy feature implemented',
        at: card.status_text_updated_at,
      }));
      expect(card.result).toEqual(expect.objectContaining({
        evidence: 'happy feature implemented',
        executor: { evidence: 'happy feature implemented' },
        latest_self_report: card.latest_self_report,
      }));

      await runtime.shutdown();
    });

    it('surfaces mirrored terminal status_text in ancestor Goal Context and HTTP card payloads', async () => {
      const fixture: FakeAgentFixture = {
        name: 'status-context-goal',
        planner: [
          { created_cards: [{ id: 'code-status-context', type: 'code', title: 'Status Context Leaf', description: 'leaf', status: 'backlog', depends_on: [], priority: 1 }], status: 'continue' },
          { updated_cards: [{ id: 'code-status-context', status: 'changed' }], status: 'blocked', blocked_reason: 'stop after observing child status' },
        ],
        executor: {
          'code-status-context': { card_id: 'code-status-context', status: 'done', status_text: 'Leaf status visible to ancestor', result: { evidence: 'visible' } },
        },
        reviewer: [{ assessment: { id: 'review-status-context', goal_card_id: 'goal-status-context', reviewer_session_id: 'rev-status-context', assessment_id: 'assessment-status-context', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'Status context accepted', achieved: [], issues: [], evidence_card_ids: ['code-status-context'], created_at: new Date().toISOString() } }],
      };
      writeFixture(fixtureDir, 'status-context-goal', fixture);
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-status-context', 'Status Context Goal');
      const fakeAgent = new FakeAgentAdapter({ mapping: { 'goal-status-context': 'status-context-goal' }, fixtureDir });
      const plannerPrompts: string[] = [];
      const originalInvokePlanner = fakeAgent.invokePlanner.bind(fakeAgent);
      fakeAgent.invokePlanner = ((goalId: string, systemPrompt?: string) => {
        plannerPrompts.push(systemPrompt ?? '');
        return originalInvokePlanner(goalId, systemPrompt);
      }) as typeof fakeAgent.invokePlanner;

      runtime = new Runtime(makeDefaultConfig({ 'goal-status-context': 'status-context-goal' }), fakeAgent);
      await runtime.startup();
      await runtime.dispatchGoal('goal-status-context');

      expect(plannerPrompts.length).toBeGreaterThanOrEqual(2);
      expect(plannerPrompts[1]).toContain('"status_text": "Leaf status visible to ancestor"');

      const app = Fastify();
      const { registerCardRoutes } = await import('../../src/server/routes/cards.js');
      registerCardRoutes(app, tmpDir);
      const response = await app.inject({ method: 'GET', url: '/api/cards/code-status-context' });
      await app.close();
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.payload).card).toEqual(expect.objectContaining({
        id: 'code-status-context',
        status_text: 'Leaf status visible to ancestor',
      }));

      await runtime.shutdown();
    });

    it('restart_card preserves mirrored status_text until the next executor run overwrites it', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Happy Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();
      await runtime.dispatchGoal('goal-1');
      await runtime.shutdown();

      const tools = await import('../../src/utils/planner-tools.js');
      const service = new tools.PlannerToolsService(store, () => null);
      const restarted = service.restartCard('code-happy-1');
      expect(restarted.status).toBe('active');
      expect(restarted.status_text).toBe('Happy feature implemented');
      expect(restarted.latest_self_report).toEqual(expect.objectContaining({ status_text: 'Happy feature implemented' }));
      expect(restarted.result).not.toHaveProperty('executor');
      expect(restarted.result).toEqual(expect.objectContaining({ evidence: 'happy feature implemented' }));

      store.setStatus('goal-1', 'backlog');

      const rerunFixture: FakeAgentFixture = {
        name: 'status-rerun-goal',
        planner: [{ updated_cards: [], status: 'done' }],
        executor: {
          'code-happy-1': { card_id: 'code-happy-1', status: 'done', status_text: 'Happy feature rerun completed', result: { evidence: 'rerun' } },
        },
        reviewer: [{ assessment: { id: 'review-rerun', goal_card_id: 'goal-1', reviewer_session_id: 'rev-rerun', assessment_id: 'assessment-rerun', at: '2025-01-01T00:00:00.000Z', result: 'pass', summary: 'Rerun accepted', achieved: [], issues: [], evidence_card_ids: ['code-happy-1', 'code-happy-2'], created_at: new Date().toISOString() } }],
      };
      writeFixture(fixtureDir, 'status-rerun-goal', rerunFixture);
      runtime = new Runtime(makeDefaultConfig({ 'goal-1': 'status-rerun-goal' }));
      await runtime.startup();
      await runtime.dispatchGoal('goal-1');

      const rerun = store.read('code-happy-1')!;
      expect(rerun.status).toBe('done');
      expect(rerun.status_text).toBe('Happy feature rerun completed');
      expect(rerun.latest_self_report).toEqual(expect.objectContaining({ status_text: 'Happy feature rerun completed' }));

      await runtime.shutdown();
    });
  });

  describe('Planner goal-owned planning contract', () => {
    it('allows blocked goals to be reopened to backlog for replanning', () => {
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-reopen', 'Reopen Blocked Goal');
      store.setStatus('goal-reopen', 'active');
      store.setStatus('goal-reopen', 'running');
      store.setStatus('goal-reopen', 'blocked');

      store.setStatus('goal-reopen', 'backlog');

      expect(store.read('goal-reopen')!.status).toBe('backlog');
    });

    it('stores planner progress on goal planning state', async () => {
      createPlannerPlanCardFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-plan-card', 'Planner Plan Card Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();
      await runtime.dispatchGoal('goal-plan-card');

      const goal = store.read('goal-plan-card');
      expect(goal!.status).toBe('done');
      expect(store.read('research-plan-card-1')!.status).toBe('done');
      expect(store.read('plan-goal-plan-card')).toBeNull();
      expect(store.read('plan-1')).toBeNull();
      expect(goal!.result?.planning).toMatchObject({
        status: 'done',
      });
      expect((goal!.result?.planning as { created_cards?: string[] }).created_cards).toEqual([]);

      await runtime.shutdown();
    });

    it('marks a goal blocked when the planner returns blocked', async () => {
      createBlockedPlannerFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-blocked', 'Blocked Goal');

      const fakeAgent = new FakeAgentAdapter({
        mapping: { 'goal-blocked': 'blocked-planner-goal' },
        fixtureDir,
      });
      runtime = new Runtime({
        projectRoot: tmpDir,
        fakeAgentConfig: { mapping: { 'goal-blocked': 'blocked-planner-goal' }, fixtureDir },
      }, fakeAgent);
      await runtime.startup();
      await runtime.dispatchGoal('goal-blocked');

      const goal = store.read('goal-blocked');
      expect(goal!.status).toBe('blocked');
      expect(goal!.result?.planning).toMatchObject({
        status: 'blocked',
        blocked_reason: 'Needs parent planner to choose a different strategy.',
      });
      expect(fakeAgent.getPlannerCount('goal-blocked')).toBe(1);

      await runtime.shutdown();
    });

    it('idles persisted runtime state when planner already marked reviewed goal done', async () => {
      createPlannerMarksGoalDoneFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-planner-done', 'Planner Done Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      const completedEvents: string[] = [];
      runtime.on('goal_completed', () => completedEvents.push('goal_completed'));

      await runtime.dispatchGoal('goal-planner-done');

      expect(store.read('goal-planner-done')!.status).toBe('done');
      expect(completedEvents).toContain('goal_completed');
      expect(readRuntimeState(tmpDir)).toMatchObject({
        status: 'idle',
        current_card_id: null,
        current_agent_session_id: null,
        queue: [],
      });

      await runtime.shutdown();
    });
  });

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

      const goal = store.read('goal-2');
      expect(goal!.status).toBe('done');

      const correctionCard = store.read('code-rf-2');
      expect(correctionCard).not.toBeNull();
      expect(correctionCard!.status).toBe('done');

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

      const origCard = store.read('code-rf-1');
      const corrCard = store.read('code-rf-2');
      expect(origCard!.status).toBe('done');
      expect(corrCard!.status).toBe('done');
      expect(events).toContain('review_failed');
      expect(events).toContain('goal_completed');

      await runtime.shutdown();
    });
  });

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

      const failedCard = store.read('code-ef-1');
      expect(failedCard!.status).toBe('failed');
      expect(failedCard!.error).toBe('Build error');

      const replCard = store.read('code-ef-2');
      expect(replCard).not.toBeNull();
      expect(replCard!.status).toBe('done');

      expect(cardFailedEvents.length).toBeGreaterThanOrEqual(1);
      expect(cardFailedEvents[0].cardId).toBe('code-ef-1');

      const goal = store.read('goal-3');
      expect(goal!.status).toBe('done');

      await runtime.shutdown();
    });
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
    it('resets active and running cards to backlog after crash', () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Crash Goal');

      store.setStatus('goal-1', 'active');
      makeTerminalCard(store, 'code-crash-1', 'goal-1', {
        status: 'running',
      });

      runtime = new Runtime(makeDefaultConfig());
      runtime.simulateCrash();

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');

      const card = store.read('code-crash-1');
      expect(card!.status).toBe('backlog');
    });

    it('runtime can resume after crash recovery', async () => {
      createCrashRecoveryFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Resume Goal');

      store.setStatus('goal-1', 'active');
      makeTerminalCard(store, 'code-resume-1', 'goal-1', {
        status: 'running',
      });

      runtime = new Runtime(makeDefaultConfig({ 'goal-1': 'crash-recovery' }));

      runtime.performCrashRecovery();

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');
      const card = store.read('code-resume-1');
      expect(card!.status).toBe('backlog');

      await runtime.startup();
      await runtime.dispatchGoal('goal-1');

      const goalAfter = store.read('goal-1');
      expect(goalAfter!.status).toBe('done');

      await runtime.shutdown();
    });
  });

  describe('Pause / Resume', () => {
    it('pause stops dispatch, resume allows it', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);
      makeGoalCard(store, 'goal-1', 'Pause Goal');

      runtime = new Runtime(makeDefaultConfig());
      await runtime.startup();

      runtime.pause();
      expect(runtime.paused).toBe(true);

      const blockedEvents: unknown[] = [];
      runtime.on('dispatch_blocked', (data) => blockedEvents.push(data));

      await runtime.dispatchGoal('goal-1');
      expect(blockedEvents.length).toBeGreaterThanOrEqual(1);

      const goal = store.read('goal-1');
      expect(goal!.status).toBe('backlog');

      runtime.resume();
      expect(runtime.paused).toBe(false);

      await runtime.dispatchGoal('goal-1');
      const goalAfter = store.read('goal-1');
      expect(goalAfter!.status).toBe('done');

      await runtime.shutdown();
    });
  });

  describe('Queue ordering', () => {
    it('sorts ready cards by depends_on then priority', () => {
      const store = new CardStore(tmpDir);
      const goal = makeGoalCard(store, 'goal-q', 'Queue Goal');

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

      expect(queue.length).toBe(2);
      expect(queue[0].id).toBe(c3.id);
      expect(queue[1].id).toBe(c1.id);

      store.setStatus(c1.id, 'active');
      store.setStatus(c1.id, 'running');
      store.setStatus(c1.id, 'done');

      const queue2 = runtime.getReadyQueue(goal.id);
      expect(queue2.length).toBe(2);
      expect(queue2[0].id).toBe(c3.id);
      expect(queue2[1].id).toBe(c2.id);
    });
  });

  describe('AC 7: Goal with per-goal instructions_file dispatch', () => {
    it('dispatches a depth > 0 goal with instructions_file set', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);

      store.create({
        id: 'goal-instr',
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'Goal With Instructions',
        description: 'A goal that has custom planner instructions',
        status: 'backlog',
        tags: [],
        priority: 1,
        urgency: 'normal',
        created_by: 'analyst',
        depends_on: [],
        blocks: [],
        related: [],
        acceptance: 'Testing instructions_file',
        artifacts: [],
        attachments: [],
        retries: 0,
        instructions_file: 'my-goal-instructions.md',
      });

      writeFileSync(join(tmpDir, 'my-goal-instructions.md'),
        '# Special instructions\nBe thorough.', 'utf-8');

      runtime = new Runtime(makeDefaultConfig({ 'goal-instr': 'happy-goal' }));
      await runtime.startup();

      await runtime.dispatchGoal('goal-instr');

      const done = store.read('goal-instr');
      expect(done!.status).toBe('done');

      await runtime.shutdown();
    });

    it('depth > 0 goal without instructions_file still works', async () => {
      createHappyPathFixture();
      const store = new CardStore(tmpDir);

      store.create({
        id: 'goal-no-instr',
        type: 'goal',
        parent: 'project',
        depth: 1,
        title: 'Goal Without Instructions',
        description: 'A goal without custom planner instructions',
        status: 'backlog',
        tags: [],
        priority: 1,
        urgency: 'normal',
        created_by: 'analyst',
        depends_on: [],
        blocks: [],
        related: [],
        acceptance: 'Testing no instructions',
        artifacts: [],
        attachments: [],
        retries: 0,
      });

      runtime = new Runtime(makeDefaultConfig({ 'goal-no-instr': 'happy-goal' }));
      await runtime.startup();

      await runtime.dispatchGoal('goal-no-instr');

      const done = store.read('goal-no-instr');
      expect(done!.status).toBe('done');

      await runtime.shutdown();
    });

    it('depth-0 project planner still works unchanged', async () => {
      createHappyPathFixture();

      runtime = new Runtime(makeDefaultConfig({ project: 'happy-goal' }));
      await runtime.startup();

      await runtime.dispatchGoal('project');

      const project = runtime.cardStore.read('project');
      expect(project!.status).toBe('done');

      await runtime.shutdown();
    });
  });
});

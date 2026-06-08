import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/runtime/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

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
  let dispatchTools: RuntimeCoreTestContainer['dispatchTestTools'];
  let harness: RuntimeCoreTestContainer;

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
          status: 'continue',
          summary: 'Planner continued after direct card setup.',
        },
        {
          status: 'done',
        },
        {
          status: 'done',
        },
        {
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
    harness = createRuntimeCoreTestContainer({
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

    it('any object implementing AgentRuntime can be injected', () => {
      const minimalRt: AgentRuntime = {
        invokePlanner(_request) {
          return {
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

  describe('Runtime without explicit agentRuntime', () => {
    it('Runtime creates FakeAgentAdapter internally when no agentRuntime passed', () => {
      createHappyPathFixture();

      makeRuntime();

      expect(harness.agentRuntimeTestTools.getConstructorName()).toBe(FakeAgentAdapter.name);
    });

  });
});

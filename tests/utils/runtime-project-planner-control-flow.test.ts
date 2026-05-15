import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';

describe('Runtime project planner control flow diagnosis', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  function makeFixtureDir(baseDir: string): string {
    const dir = join(baseDir, 'fixtures');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-project-loop-'));
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

  it('shows goal-local and project-level control gaps: done skips child execution and project planner does not resume', async () => {
    const projectFixture: FakeAgentFixture = {
      name: 'project-parent',
      planner: [
        {
          status: 'done',
          created_cards: [
            {
              id: 'goal-parent-1',
              type: 'goal',
              title: 'Initial top-level goal',
              description: 'Create one top-level goal.',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          summary: 'Initial project planning created one top-level goal.',
        },
        {
          status: 'done',
          created_cards: [
            {
              id: 'goal-parent-2',
              type: 'goal',
              title: 'Follow-up strategic goal',
              description: 'Would appear only if the project planner resumed after child completion.',
              status: 'backlog',
              depends_on: [],
              priority: 2,
            },
          ],
          summary: 'Project planner resumed and created a second goal.',
        },
      ],
      executor: {},
      reviewer: [
        {
          assessment: {
            id: 'review-project',
            goal_card_id: 'project',
            reviewer_session_id: 'rev-project',
            result: 'pass',
            summary: 'Project planning step was accepted.',
            achieved: ['Created one top-level goal'],
            missing: [],
            evidence_card_ids: ['goal-parent-1'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    const goalFixture: FakeAgentFixture = {
      name: 'goal-done-with-child-work',
      planner: [
        {
          status: 'done',
          created_cards: [
            {
              id: 'code-parent-1',
              type: 'code',
              title: 'Initial terminal card',
              description: 'This card should run before review if parent planning/dispatch were explicit.',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          summary: 'Created a child card but also declared done.',
        },
      ],
      executor: {
        'code-parent-1': { card_id: 'code-parent-1', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-goal',
            goal_card_id: 'goal-parent-1',
            reviewer_session_id: 'rev-goal',
            result: 'fail',
            summary: 'Acceptance is incomplete because the created child card never executed.',
            achieved: [],
            missing: ['Execution evidence for code-parent-1'],
            evidence_card_ids: [],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    writeFixture(fixtureDir, 'project-parent', projectFixture);
    writeFixture(fixtureDir, 'goal-done-with-child-work', goalFixture);

    const fakeAgent = new FakeAgentAdapter({
      mapping: {
        project: 'project-parent',
        'goal-parent-1': 'goal-done-with-child-work',
      },
      fixtureDir,
    });

    runtime = new Runtime({
      projectRoot: tmpDir,
      fakeAgentConfig: {
        mapping: {
          project: 'project-parent',
          'goal-parent-1': 'goal-done-with-child-work',
        },
        fixtureDir,
      },
    }, fakeAgent);

    await runtime.startup();
    await runtime.dispatchGoal('project');
    await runtime.dispatchGoal('goal-parent-1');

    expect(fakeAgent.getPlannerCount('project')).toBe(1);
    expect(fakeAgent.getPlannerCount('goal-parent-1')).toBe(1);

    expect(runtime.cardStore.read('goal-parent-1')?.status).toBe('active');
    expect(runtime.cardStore.read('code-parent-1')?.status).toBe('backlog');
    expect(runtime.cardStore.read('goal-parent-2')).toBeNull();
  });
});

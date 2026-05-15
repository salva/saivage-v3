import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, readFileSync, rmSync, mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';

describe('Runtime project planner control flow', () => {
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
      try { await runtime.shutdown(); } catch {}
    }
    try { releaseLock(tmpDir); } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('resumes the project planner after child completion, runs two leaf cards, and creates follow-up work', async () => {
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
              id: 'code-project-followup-1',
              type: 'code',
              title: 'Project follow-up card',
              description: 'Follow-up work created only after project planner resumed.',
              status: 'backlog',
              depends_on: [],
              priority: 2,
            },
          ],
          summary: 'Project planner resumed and created a follow-up card.',
        },
      ],
      executor: {
        'code-project-followup-1': { card_id: 'code-project-followup-1', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-project',
            goal_card_id: 'project',
            reviewer_session_id: 'rev-project',
            result: 'pass',
            summary: 'Project planning and follow-up work were accepted.',
            achieved: ['Created one top-level goal', 'Created and executed follow-up card'],
            missing: [],
            evidence_card_ids: ['goal-parent-1', 'code-project-followup-1'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    const goalFixture: FakeAgentFixture = {
      name: 'goal-two-leaves',
      planner: [
        {
          status: 'done',
          created_cards: [
            {
              id: 'code-parent-1',
              type: 'code',
              title: 'First leaf card',
              description: 'This card should execute.',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
            {
              id: 'code-parent-2',
              type: 'code',
              title: 'Second leaf card',
              description: 'This card should execute after the first.',
              status: 'backlog',
              depends_on: ['code-parent-1'],
              priority: 2,
            },
          ],
          summary: 'Created two child cards and declared done.',
        },
      ],
      executor: {
        'code-parent-1': { card_id: 'code-parent-1', status: 'done' },
        'code-parent-2': { card_id: 'code-parent-2', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-goal',
            goal_card_id: 'goal-parent-1',
            reviewer_session_id: 'rev-goal',
            result: 'pass',
            summary: 'Both leaf cards executed.',
            achieved: ['Execution evidence for code-parent-1', 'Execution evidence for code-parent-2'],
            missing: [],
            evidence_card_ids: ['code-parent-1', 'code-parent-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    writeFixture(fixtureDir, 'project-parent', projectFixture);
    writeFixture(fixtureDir, 'goal-two-leaves', goalFixture);

    const fakeAgent = new FakeAgentAdapter({
      mapping: {
        project: 'project-parent',
        'goal-parent-1': 'goal-two-leaves',
      },
      fixtureDir,
    });

    runtime = new Runtime({
      projectRoot: tmpDir,
      fakeAgentConfig: {
        mapping: {
          project: 'project-parent',
          'goal-parent-1': 'goal-two-leaves',
        },
        fixtureDir,
      },
    }, fakeAgent);

    await runtime.startup();
    await runtime.dispatchGoal('project');

    expect(fakeAgent.getPlannerCount('project')).toBe(2);
    expect(fakeAgent.getPlannerCount('goal-parent-1')).toBe(1);
    expect(runtime.cardStore.read('goal-parent-1')?.status).toBe('done');
    expect(runtime.cardStore.read('code-parent-1')?.status).toBe('done');
    expect(runtime.cardStore.read('code-parent-2')?.status).toBe('done');
    expect(runtime.cardStore.read('code-project-followup-1')?.status).toBe('done');
    expect((runtime.cardStore.read('goal-parent-1')?.result?.planning as { status?: string })?.status).toBe('done');

    const frameDir = join(tmpDir, '.saivage', 'runtime', 'planner-frames');
    const dispatchDir = join(tmpDir, '.saivage', 'runtime', 'planner-dispatches');
    expect(existsSync(frameDir)).toBe(true);
    expect(existsSync(dispatchDir)).toBe(true);
    expect(readdirSync(frameDir).length).toBeGreaterThan(0);
    expect(readdirSync(dispatchDir).length).toBeGreaterThan(0);

    const projectFrameFile = readdirSync(frameDir).find((name) => name.includes('project'));
    expect(projectFrameFile).toBeDefined();
    const projectFrame = JSON.parse(readFileSync(join(frameDir, projectFrameFile!), 'utf-8')) as { status: string; resume_reason: string };
    expect(projectFrame.status).toBe('completed');
    expect(projectFrame.resume_reason).toBe('review_completed');

    const dispatchRecords = readdirSync(dispatchDir)
      .map((name) => JSON.parse(readFileSync(join(dispatchDir, name), 'utf-8')) as { target_card_id: string; status: string; completion: { outcome: string } | null })
      .filter((record) => ['goal-parent-1', 'code-parent-1', 'code-parent-2', 'code-project-followup-1'].includes(record.target_card_id));
    expect(dispatchRecords).toHaveLength(4);
    expect(dispatchRecords.every((record) => record.status === 'completed')).toBe(true);
    expect(dispatchRecords.every((record) => record.completion?.outcome === 'done')).toBe(true);
  });
});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { PlannerControlService } from '../../src/utils/planner-control.js';
import { Runtime } from '../../src/utils/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';

describe('PlannerControlService invariants', () => {
  let tmpDir: string;
  let service: PlannerControlService;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-pc-'));
    initProjectTree(tmpDir);
    service = new PlannerControlService(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('ensureFrame creates a queued frame', () => {
    const frame = service.ensureFrame('project', 'project');
    expect(frame.status).toBe('queued');
  });

  it('creating a dispatch suspends the parent frame and records waiting ids', () => {
    const frame = service.ensureFrame('goal-1', 'goal');
    const dispatch = service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-1',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-1',
    });

    const updatedFrame = service.readFrame(frame.frame_id);
    expect(updatedFrame?.status).toBe('suspended');
    expect(updatedFrame?.waiting_on_dispatch_ids).toContain(dispatch.dispatch_id);
  });

  it('rejects completed dispatch without completion evidence', () => {
    const frame = service.ensureFrame('goal-1', 'goal');
    const dispatch = service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-1',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-1',
    });

    expect(() =>
      service.markDispatchCompleted(
        dispatch.dispatch_id,
        'completed',
        null as never,
      ),
    ).toThrow(/cannot complete without durable completion evidence/i);
  });

  it('rejects completed dispatch whose outcome does not match status', () => {
    const frame = service.ensureFrame('goal-1', 'goal');
    const dispatch = service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-1',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-1',
    });

    expect(() =>
      service.markDispatchCompleted(dispatch.dispatch_id, 'failed', {
        outcome: 'done',
        summary: 'wrong',
        child_result: null,
        review: null,
        artifacts: [],
        attachments: [],
        evidence_card_ids: [],
        error: 'bad',
      }),
    ).toThrow(/requires completion outcome 'failed'/i);
  });

  it('keeps the parent suspended while other waiting dispatches remain', () => {
    const frame = service.ensureFrame('goal-1', 'goal');
    const one = service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-1',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-1',
    });
    service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-2',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-2',
    });

    service.markDispatchCompleted(one.dispatch_id, 'completed', {
      outcome: 'done',
      summary: 'done',
      child_result: { ok: true },
      review: null,
      artifacts: [],
      attachments: [],
      evidence_card_ids: ['code-1'],
      error: null,
    });

    const updatedFrame = service.readFrame(frame.frame_id);
    expect(updatedFrame?.status).toBe('suspended');
    expect(updatedFrame?.waiting_on_dispatch_ids).toHaveLength(1);
    expect(updatedFrame?.resume_reason).toBe('none');
  });

  it('makes the parent resumable only after durable completion is written and all waiting ids are cleared', () => {
    const frame = service.ensureFrame('goal-1', 'goal');
    const dispatch = service.createDispatch({
      parentFrameId: frame.frame_id,
      parentCardId: 'goal-1',
      targetCardId: 'code-1',
      targetKind: 'terminal_card',
      requestedByScope: 'goal',
      idempotencyKey: 'goal-1:code-1',
    });

    service.markDispatchCompleted(dispatch.dispatch_id, 'completed', {
      outcome: 'done',
      summary: 'done',
      child_result: { ok: true },
      review: null,
      artifacts: [],
      attachments: [],
      evidence_card_ids: ['code-1'],
      error: null,
    });

    const persistedDispatch = service.readDispatch(dispatch.dispatch_id);
    const updatedFrame = service.readFrame(frame.frame_id);
    expect(persistedDispatch?.completion).not.toBeNull();
    expect(persistedDispatch?.completed_at).not.toBeNull();
    expect(updatedFrame?.status).toBe('resumable');
    expect(updatedFrame?.waiting_on_dispatch_ids).toEqual([]);
    expect(updatedFrame?.resume_reason).toBe('dispatch_completed');
    expect(updatedFrame?.last_resume_cursor).toBe(persistedDispatch?.completed_at ?? null);
  });
});

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

  it('resumes the project planner after child completion and dispatches a second top-level goal', async () => {
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
              description: 'Create the first top-level goal.',
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
              title: 'Second top-level goal',
              description: 'Create a second top-level goal after the first completes.',
              status: 'backlog',
              depends_on: [],
              priority: 2,
            },
          ],
          summary: 'Project planner resumed and created a second top-level goal.',
        },
        {
          status: 'done',
          created_cards: [],
          summary: 'Project planner resumed again after the second goal completed and confirmed no further work.',
        },
      ],
      reviewer: [
        {
          assessment: {
            id: 'review-project',
            goal_card_id: 'project',
            reviewer_session_id: 'rev-project',
            result: 'pass',
            summary: 'Project planning and follow-up goals were accepted.',
            achieved: ['Created first top-level goal', 'Created second top-level goal after resume'],
            missing: [],
            evidence_card_ids: ['goal-parent-1', 'goal-parent-2'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    const goalOneFixture: FakeAgentFixture = {
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
            id: 'review-goal-1',
            goal_card_id: 'goal-parent-1',
            reviewer_session_id: 'rev-goal-1',
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

    const goalTwoFixture: FakeAgentFixture = {
      name: 'goal-one-leaf',
      planner: [
        {
          status: 'done',
          created_cards: [
            {
              id: 'code-parent-3',
              type: 'code',
              title: 'Third leaf card',
              description: 'This card should execute for the second top-level goal.',
              status: 'backlog',
              depends_on: [],
              priority: 1,
            },
          ],
          summary: 'Created one child card and declared done.',
        },
      ],
      executor: {
        'code-parent-3': { card_id: 'code-parent-3', status: 'done' },
      },
      reviewer: [
        {
          assessment: {
            id: 'review-goal-2',
            goal_card_id: 'goal-parent-2',
            reviewer_session_id: 'rev-goal-2',
            result: 'pass',
            summary: 'The second top-level goal leaf card executed.',
            achieved: ['Execution evidence for code-parent-3'],
            missing: [],
            evidence_card_ids: ['code-parent-3'],
            created_at: new Date().toISOString(),
          },
        },
      ],
    };

    writeFixture(fixtureDir, 'project-parent', projectFixture);
    writeFixture(fixtureDir, 'goal-two-leaves', goalOneFixture);
    writeFixture(fixtureDir, 'goal-one-leaf', goalTwoFixture);

    const fakeAgent = new FakeAgentAdapter({
      mapping: {
        project: 'project-parent',
        'goal-parent-1': 'goal-two-leaves',
        'goal-parent-2': 'goal-one-leaf',
      },
      fixtureDir,
    });

    runtime = new Runtime({
      projectRoot: tmpDir,
      fakeAgentConfig: {
        mapping: {
          project: 'project-parent',
          'goal-parent-1': 'goal-two-leaves',
          'goal-parent-2': 'goal-one-leaf',
        },
        fixtureDir,
      },
    }, fakeAgent);

    await runtime.startup();
    await runtime.dispatchGoal('project');

    expect(fakeAgent.getPlannerCount('project')).toBe(3);
    expect(fakeAgent.getPlannerCount('goal-parent-1')).toBe(1);
    expect(fakeAgent.getPlannerCount('goal-parent-2')).toBe(1);

    expect(runtime.cardStore.read('goal-parent-1')?.status).toBe('done');
    expect(runtime.cardStore.read('goal-parent-2')?.status).toBe('done');
    expect(runtime.cardStore.read('code-parent-1')?.status).toBe('done');
    expect(runtime.cardStore.read('code-parent-2')?.status).toBe('done');
    expect(runtime.cardStore.read('code-parent-3')?.status).toBe('done');
    expect((runtime.cardStore.read('goal-parent-1')?.result?.planning as { status?: string })?.status).toBe('done');
    expect((runtime.cardStore.read('goal-parent-2')?.result?.planning as { status?: string })?.status).toBe('done');

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
      .filter((record) => ['goal-parent-1', 'goal-parent-2', 'code-parent-1', 'code-parent-2', 'code-parent-3'].includes(record.target_card_id));
    expect(dispatchRecords).toHaveLength(5);
    expect(dispatchRecords.every((record) => record.status === 'completed')).toBe(true);
    expect(dispatchRecords.every((record) => record.completion?.outcome === 'done')).toBe(true);
  });
});

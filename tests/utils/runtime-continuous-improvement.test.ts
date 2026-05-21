import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { Runtime } from '../../src/utils/runtime.js';
import type { FakeAgentFixture } from '../../src/utils/fake-agent.js';
import { releaseLock } from '../../src/utils/runtime-lock.js';
import { startProcess, snapshotProcessRuntimeScope } from '../../src/utils/process-runner.js';
import type { CardRecord, CardStatus } from '../../src/schemas/types.js';

function makeFixtureDir(tmpDir: string): string {
  const dir = join(tmpDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

function advanceToTerminal(store: CardStore, goalId: string, targetStatus: CardStatus = 'done'): void {
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

function createProjectImprovementFixture(fixtureDir: string): void {
  writeFixture(fixtureDir, 'project-improvement', {
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
  });
}

describe('Runtime continuousImprovement reserved config', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ci-noop-'));
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

  it('does not invoke an improvement planner even when reserved flag is true and all top-level goals are terminal', async () => {
    createProjectImprovementFixture(fixtureDir);
    const setupStore = new CardStore(tmpDir);
    makeGoalCard(setupStore, 'goal-1', 'Feature A');
    advanceToTerminal(setupStore, 'goal-1', 'done');
    makeGoalCard(setupStore, 'goal-2', 'Feature B');
    advanceToTerminal(setupStore, 'goal-2', 'done');

    runtime = new Runtime({
      projectRoot: tmpDir,
      continuousImprovement: true,
      fakeAgentConfig: { mapping: { project: 'project-improvement' }, fixtureDir },
    });

    const improvementListener = jest.fn();
    const continuousPlanListener = jest.fn((data: unknown) => {
      if ((data as { source?: string }).source === 'continuous-improvement') return true;
      return false;
    });
    runtime.on('improvement_invoked', improvementListener);
    runtime.on('plan_updated', continuousPlanListener);

    await runtime.startup();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(improvementListener).not.toHaveBeenCalled();
    expect(continuousPlanListener).not.toHaveBeenCalled();
    expect(runtime.cardStore.read('goal-ci-1')).toBeNull();
  });

  it('runtime shutdown is idempotent and disposes the process lifecycle scope before logger close', async () => {
    runtime = new Runtime({
      projectRoot: tmpDir,
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    await runtime.startup();
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-runtime-shutdown', ownerKind: 'runtime' });
    runtime.trackProcessStarted(rec.id);
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await runtime.shutdown();
    await runtime.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(runtime.lastLifecycleDisposeReport).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'child_process', status: expect.stringMatching(/detached|killed/) }),
    ]));
  });

  it('partial startup failure releases runtime-owned process scope resources', async () => {
    runtime = new Runtime({
      projectRoot: tmpDir,
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-partial-startup', ownerKind: 'runtime' });
    await runtime.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await import('../../src/utils/process-runner.js').then(({ disposeProcessRuntimeScope }) => disposeProcessRuntimeScope(tmpDir));
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(rec.id).toMatch(/^proc-/);
  });

  it('does not write continuous-improvement events to the runtime event log', async () => {
    createProjectImprovementFixture(fixtureDir);
    const setupStore = new CardStore(tmpDir);
    makeGoalCard(setupStore, 'goal-1', 'Done Goal');
    advanceToTerminal(setupStore, 'goal-1', 'done');

    runtime = new Runtime({
      projectRoot: tmpDir,
      continuousImprovement: true,
      fakeAgentConfig: { mapping: { project: 'project-improvement' }, fixtureDir },
    });

    await runtime.startup();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const eventsPath = join(tmpDir, '.saivage', 'runtime', 'events.jsonl');
    const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8') : '';
    expect(events).not.toContain('improvement_invoked');
    expect(events).not.toContain('continuous-improvement');
  });
});

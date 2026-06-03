import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { startProcess, snapshotProcessRuntimeScope } from '../../src/runtime/process-runner.js';
import type { CardRecord, CardStatus } from '../../src/schemas/types.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';

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
  let harness: RuntimeCoreTestContainer | undefined;

  function createRuntime(config: Omit<Parameters<typeof createRuntimeCoreTestContainer>[0]['config'], 'projectRoot' | 'fakeAgentConfig'> & {
    fakeAgentConfig: Parameters<typeof createRuntimeCoreTestContainer>[0]['config']['fakeAgentConfig'];
  }): void {
    harness = createRuntimeCoreTestContainer({
      config: { projectRoot: tmpDir, ...config },
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-ci-noop-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (harness) {
      try { await harness.api.shutdown(); } catch {}
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

    createRuntime({
      continuousImprovement: true,
      fakeAgentConfig: { mapping: { project: 'project-improvement' }, fixtureDir },
    });

    const improvementListener = jest.fn();
    const continuousPlanListener = jest.fn((data: unknown) => {
      if ((data as { source?: string }).source === 'continuous-improvement') return true;
      return false;
    });
    harness!.eventTestTools.on('improvement_invoked', improvementListener);
    harness!.eventTestTools.on('plan_updated', continuousPlanListener);

    await harness!.api.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    expect(improvementListener).not.toHaveBeenCalled();
    expect(continuousPlanListener).not.toHaveBeenCalled();
    expect(harness?.cardTestTools.read('goal-ci-1')).toBeNull();
  });

  it('runtime shutdown is idempotent and disposes the process lifecycle scope before logger close', async () => {
    createRuntime({
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    await harness!.api.start();
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-runtime-shutdown', ownerKind: 'runtime' });
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await harness!.api.shutdown();
    await harness!.api.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(harness?.diagnosticTestTools.getLastLifecycleDisposeReport()).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'child_process', status: expect.stringMatching(/detached|killed/) }),
    ]));
  });

  it('partial startup failure releases runtime-owned process scope resources', async () => {
    createRuntime({
      continuousImprovement: false,
      fakeAgentConfig: { mapping: {}, fixtureDir },
    });
    const rec = startProcess(tmpDir, 'sleep 5', { cardId: 'card-partial-startup', ownerKind: 'runtime' });
    await harness!.api.shutdown();
    expect(snapshotProcessRuntimeScope(tmpDir).resources.length).toBeGreaterThan(0);
    await import('../../src/runtime/process-runner.js').then(({ disposeProcessRuntimeScope }) => disposeProcessRuntimeScope(tmpDir));
    expect(snapshotProcessRuntimeScope(tmpDir).resources).toHaveLength(0);
    expect(rec.id).toMatch(/^proc-/);
  });

  it('does not write continuous-improvement events to the runtime event log', async () => {
    createProjectImprovementFixture(fixtureDir);
    const setupStore = new CardStore(tmpDir);
    makeGoalCard(setupStore, 'goal-1', 'Done Goal');
    advanceToTerminal(setupStore, 'goal-1', 'done');

    createRuntime({
      continuousImprovement: true,
      fakeAgentConfig: { mapping: { project: 'project-improvement' }, fixtureDir },
    });

    await harness!.api.start();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));

    const eventsPath = join(tmpDir, '.saivage', 'runtime', 'events.jsonl');
    const events = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf-8') : '';
    expect(events).not.toContain('improvement_invoked');
    expect(events).not.toContain('continuous-improvement');
  });
});

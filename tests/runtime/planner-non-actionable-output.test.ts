import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';

function makeFixtureDir(baseDir: string): string {
  const dir = join(baseDir, 'fixtures');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir: string, name: string, fixture: FakeAgentFixture): void {
  writeFileSync(join(dir, `${name}.json`), JSON.stringify(fixture, null, 2), 'utf-8');
}

describe('planner output actionability guard', () => {
  let tmpDir: string;
  let fixtureDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-actionability-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (runtime) {
      try { await runtime.shutdown(); } catch { /* noop */ }
    }
    try { releaseLock(tmpDir); } catch { /* noop */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists an explicit blocker when a planner returns continue without durable actions', async () => {
    const fixture: FakeAgentFixture = {
      name: 'non-actionable-project-planner',
      planner: [{
        status: 'continue',
        created_cards: [],
        updated_cards: [],
        summary: 'Planner continued but produced no card, update, activation, unfinished child work, or blocker.',
      }],
    };
    writeFixture(fixtureDir, 'non-actionable-project-planner', fixture);
    const fakeAgent = new FakeAgentAdapter({ mapping: { project: 'non-actionable-project-planner' }, fixtureDir });
    runtime = new Runtime({ projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'non-actionable-project-planner' }, fixtureDir } }, fakeAgent);

    await runtime.startup();
    await runtime.dispatchGoal('project');

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner returned continue without creating/updating cards');
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      resume_reason: 'non_actionable_continue',
      created_cards: [],
      updated_cards: [],
    }));
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });

  it('persists a planner-declared blocker as blocked card status and idle runtime state', async () => {
    const fixture: FakeAgentFixture = {
      name: 'blocked-project-planner',
      planner: [{
        status: 'blocked',
        blocked_reason: 'test planner declared a durable blocker',
        created_cards: [],
        updated_cards: [],
        summary: 'Planner stopped with an explicit blocker.',
      }],
    };
    writeFixture(fixtureDir, 'blocked-project-planner', fixture);
    const fakeAgent = new FakeAgentAdapter({ mapping: { project: 'blocked-project-planner' }, fixtureDir });
    runtime = new Runtime({ projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'blocked-project-planner' }, fixtureDir } }, fakeAgent);

    await runtime.startup();
    await runtime.dispatchGoal('project');

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toBe('test planner declared a durable blocker');
    expect(project?.status_text).toBe('test planner declared a durable blocker');
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      resume_reason: 'planner_blocked',
      blocked_reason: 'test planner declared a durable blocker',
      created_cards: [],
      updated_cards: [],
    }));
    expect(runtime.getState()?.status).toBe('idle');
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });
});

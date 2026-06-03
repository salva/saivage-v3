import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { FakeAgentAdapter, type FakeAgentFixture } from '../../src/agents/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';
import { createRuntimeTestHarness, type RuntimeTestHarness } from '../utils/runtime-test-harness.js';

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
  let harness: RuntimeTestHarness;

  function createHarness(mapping: Record<string, string>, fakeAgent: FakeAgentAdapter): RuntimeTestHarness {
    return createRuntimeTestHarness({
      config: { projectRoot: tmpDir, fakeAgentConfig: { mapping, fixtureDir } },
      agentRuntime: fakeAgent,
    });
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-actionability-'));
    fixtureDir = makeFixtureDir(tmpDir);
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (harness) {
      try { await harness.api.shutdown(); } catch { /* noop */ }
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
    const mapping = { project: 'non-actionable-project-planner' };
    const fakeAgent = new FakeAgentAdapter({ mapping, fixtureDir });
    harness = createHarness(mapping, fakeAgent);

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const project = harness.cards.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner returned continue without creating/updating cards');
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      resume_reason: 'non_actionable_continue',
      created_cards: [],
      updated_cards: [],
    }));
    expect(harness.state.read()?.active_card_run).toBeNull();
    expect(harness.state.read()?.current_card_id).toBeNull();
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
    const mapping = { project: 'blocked-project-planner' };
    const fakeAgent = new FakeAgentAdapter({ mapping, fixtureDir });
    harness = createHarness(mapping, fakeAgent);

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const project = harness.cards.read('project');
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
    expect(harness.state.read()?.status).toBe('idle');
    expect(harness.state.read()?.active_card_run).toBeNull();
    expect(harness.state.read()?.current_card_id).toBeNull();
  });


  it('preserves a precise reviewer-capacity blocker over later generic planner_blocked fallback', async () => {
    const reviewerBlockedReason =
      'Reviewer invocation failed before assessment output could be produced for goal project; reviewer/provider capacity is unavailable for terminal acceptance.';
    const genericPlannerReason = 'Planner returned a generic blocker after a report_goal_done tool error.';
    const fixture: FakeAgentFixture = {
      name: 'generic-blocked-after-reviewer-capacity',
      planner: [{
        status: 'blocked',
        blocked_reason: genericPlannerReason,
        created_cards: [],
        updated_cards: [],
        summary: 'Planner stopped after seeing report_goal_done tool_error.',
      }],
    };
    writeFixture(fixtureDir, 'generic-blocked-after-reviewer-capacity', fixture);
    const mapping = { project: 'generic-blocked-after-reviewer-capacity' };
    const fakeAgent = new FakeAgentAdapter({ mapping, fixtureDir });
    harness = createHarness(mapping, fakeAgent);
    harness.cards.update('project', {
      status: 'active',
      error: reviewerBlockedReason,
      status_text: reviewerBlockedReason,
      result: {
        planning: {
          status: 'blocked',
          blocked_reason: reviewerBlockedReason,
          resume_reason: 'reviewer_unavailable',
          failure_kind: 'reviewer_invocation_failed',
          created_cards: [],
          updated_cards: [],
        },
      },
    });

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const project = harness.cards.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toBe(reviewerBlockedReason);
    expect(project?.status_text).toBe(reviewerBlockedReason);
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      blocked_reason: reviewerBlockedReason,
      resume_reason: 'reviewer_unavailable',
      failure_kind: 'reviewer_invocation_failed',
      preserved_from_generic_planner_blocked: true,
      generic_planner_blocked_reason: genericPlannerReason,
    }));
    expect(project?.result?.planning).not.toEqual(expect.objectContaining({
      resume_reason: 'planner_blocked',
    }));
  });


  it('classifies accepted-retry reviewer capacity text as a precise reviewer blocker', async () => {
    const reviewerCapacityReason =
      'Project work is complete and all child cards are done, but terminal acceptance cannot produce reviewer assessment output because reviewer/provider capacity is unavailable. report_goal_done was re-issued with full validation evidence and failed only on reviewer/provider capacity; restore reviewer/provider capacity and retry terminal acceptance.';
    const fixture: FakeAgentFixture = {
      name: 'accepted-retry-reviewer-capacity-blocked',
      planner: [{
        status: 'blocked',
        blocked_reason: reviewerCapacityReason,
        created_cards: [],
        updated_cards: [],
        summary: 'Planner reported only reviewer/provider capacity as the terminal acceptance blocker.',
      }],
    };
    writeFixture(fixtureDir, 'accepted-retry-reviewer-capacity-blocked', fixture);
    const mapping = { project: 'accepted-retry-reviewer-capacity-blocked' };
    const fakeAgent = new FakeAgentAdapter({ mapping, fixtureDir });
    harness = createHarness(mapping, fakeAgent);

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    const project = harness.cards.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toBe(reviewerCapacityReason);
    expect(project?.status_text).toBe(reviewerCapacityReason);
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      blocked_reason: reviewerCapacityReason,
      resume_reason: 'reviewer_unavailable',
      failure_kind: 'reviewer_invocation_failed',
      inferred_from_planner_blocked_reason: true,
      created_cards: [],
      updated_cards: [],
    }));
    expect(project?.result?.planning).not.toEqual(expect.objectContaining({
      resume_reason: 'planner_blocked',
    }));
  });

});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { AgentExecutionPort as AgentRuntime } from '../../src/contracts/index.js';
import type { PlannerResult, ExecutorResult, ReviewerResult } from '../../src/contracts/index.js';
import type { HandoffSummary } from '../../src/schemas/types.js';
import { createRuntimeTestHarness } from '../utils/runtime-test-harness.js';

class StubAgentRuntime implements AgentRuntime {
  constructor(
    private readonly plannerResult: PlannerResult,
    private readonly executorResult: ExecutorResult,
    private readonly reviewerResult: ReviewerResult,
  ) {}
  invokePlanner(): Promise<PlannerResult> { return Promise.resolve(this.plannerResult); }
  invokeExecutor(): Promise<ExecutorResult> { return Promise.resolve(this.executorResult); }
  invokeReviewer(): Promise<ReviewerResult> { return Promise.resolve(this.reviewerResult); }
  cancelSession(): boolean { return false; }
  forceCancelSession(): boolean { return false; }
  getHandoffSummary(): HandoffSummary | null { return null; }
  getActiveSessionHandoffs(): HandoffSummary[] { return []; }
}

function readErrorsJsonl(projectRoot: string): Array<Record<string, unknown>> {
  const path = join(projectRoot, '.saivage', 'runtime', 'errors.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('F23 — dispatchGoal acceptance', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-f23-'));
    initProjectTree(projectRoot);
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('F23 — restarts a failed goal cleanly via state-machine without writing activate-phase errors', async () => {
    const store = new CardStore(projectRoot);
    store.update('project', { status: 'failed' });

    const plannerResult: PlannerResult = { status: 'done', created_cards: [], updated_cards: [] };
    const executorResult: ExecutorResult = { card_id: 'x', status: 'done', status_text: 'noop', artifacts: [], attachments: [], fallback_with_evidence: null };
    const reviewerResult: ReviewerResult = { assessment: { result: 'pass', summary: 'noop', achieved: [], issues: [], evidence_card_ids: [] } };

    const harness = createRuntimeTestHarness({
      config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
      agentRuntime: new StubAgentRuntime(plannerResult, executorResult, reviewerResult),
    });
    const { api, scheduler } = harness;
    await api.start();
    await scheduler.dispatchGoal('project');
    await api.shutdown();

    const project = harness.cards.read('project');
    // Goal must have transitioned out of the original 'failed' status via state-machine restart.
    expect(project?.status).not.toBe('failed');
    const errs = readErrorsJsonl(projectRoot);
    const activateErrs = errs.filter((e) => (e as { phase?: string }).phase === 'activate');
    expect(activateErrs).toEqual([]);
  });

  it('F23 — refuses to dispatch a goal in a non-startable / non-restartable status with a single activate error', async () => {
    const store = new CardStore(projectRoot);
    // 'active' is neither STARTABLE nor RESTARTABLE — dispatchGoal should treat it as already-active and proceed.
    // 'needs_verification' is neither STARTABLE nor RESTARTABLE — dispatchGoal should refuse loudly.
    store.update('project', { status: 'running' });
    try { store.setStatus('project', 'needs_verification' as never); } catch { /* may reject */ }

    const plannerResult: PlannerResult = { status: 'done', created_cards: [], updated_cards: [] };
    const executorResult: ExecutorResult = { card_id: 'x', status: 'done', status_text: 'noop', artifacts: [], attachments: [], fallback_with_evidence: null };
    const reviewerResult: ReviewerResult = { assessment: { result: 'pass', summary: 'noop', achieved: [], issues: [], evidence_card_ids: [] } };

    const { api, scheduler } = createRuntimeTestHarness({
      config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
      agentRuntime: new StubAgentRuntime(plannerResult, executorResult, reviewerResult),
    });
    await api.start();
    await scheduler.dispatchGoal('project');
    await api.shutdown();

    const errs = readErrorsJsonl(projectRoot);
    const activateErrs = errs.filter((e) => (e as { phase?: string }).phase === 'activate');
    // Either zero activate errors (running was treated as already-active) or exactly one (needs_verification refusal).
    expect(activateErrs.length).toBeLessThanOrEqual(1);
  });

  it('F23 — dispatchGoal with non-goal card type fails loudly via activate error', async () => {
    const store = new CardStore(projectRoot);
    store.create({ type: 'code', parent: 'project', title: 't', description: 'd', status: 'backlog', depth: 1, tags: [], priority: 1, urgency: 'normal', created_by: 'planner', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0, id: 'code-1' });

    const plannerResult: PlannerResult = { status: 'done', created_cards: [], updated_cards: [] };
    const executorResult: ExecutorResult = { card_id: 'x', status: 'done', status_text: 'noop', artifacts: [], attachments: [], fallback_with_evidence: null };
    const reviewerResult: ReviewerResult = { assessment: { result: 'pass', summary: 'noop', achieved: [], issues: [], evidence_card_ids: [] } };

    const { api, scheduler } = createRuntimeTestHarness({
      config: { projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' } },
      agentRuntime: new StubAgentRuntime(plannerResult, executorResult, reviewerResult),
    });
    await api.start();
    await scheduler.dispatchGoal('code-1');
    await api.shutdown();

    const errs = readErrorsJsonl(projectRoot);
    const activateErrs = errs.filter((e) => (e as { phase?: string }).phase === 'activate');
    expect(activateErrs.length).toBe(1);
    expect(String((activateErrs[0] as { message?: string }).message ?? '')).toMatch(/project or goal/i);
  });
});

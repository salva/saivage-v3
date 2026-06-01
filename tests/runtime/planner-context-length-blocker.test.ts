import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { LlmRequestError } from '../../src/agents/llm-errors.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { PlannerInvocationRequest, PlannerResult } from '../../src/contracts/index.js';

class ContextLengthPlannerAdapter extends FakeAgentAdapter {
  invokePlanner(_request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(_goalId: string, _systemPrompt?: string): PlannerResult;
  invokePlanner(): PlannerResult {
    throw new LlmRequestError({
      kind: 'token_budget_exceeded',
      provider: 'test-provider',
      status: 400,
      message: 'LLM token budget exceeded (HTTP 400): context_length_exceeded',
    });
  }
}

describe('planner context-length failures', () => {
  let tmpDir: string;
  let runtime: Runtime;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-context-length-'));
    mkdirSync(join(tmpDir, 'fixtures'), { recursive: true });
    initProjectTree(tmpDir);
  });

  afterEach(async () => {
    if (runtime) {
      try { await runtime.shutdown(); } catch { /* noop */ }
    }
    try { releaseLock(tmpDir); } catch { /* noop */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('persists a durable blocker instead of throwing when planner invocation exceeds token budget', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new ContextLengthPlannerAdapter({ mapping: { project: 'unused' }, fixtureDir });
    runtime = new Runtime({ projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } }, fakeAgent);

    await runtime.startup();
    await expect(runtime.dispatchGoal('project')).resolves.toBeUndefined();

    const project = runtime.cardStore.read('project');
    expect(project?.status).toBe('blocked');
    expect(project?.error).toContain('Planner context exceeded');
    expect(project?.result?.planning).toEqual(expect.objectContaining({
      status: 'blocked',
      resume_reason: 'planner_context_length_exceeded',
      failure_kind: 'token_budget_exceeded',
      created_cards: [],
      updated_cards: [],
    }));
    expect(runtime.getState()?.active_card_run).toBeNull();
    expect(runtime.getState()?.current_card_id).toBeNull();
  });
});

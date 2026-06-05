import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { FakeAgentAdapter } from '../../src/agents/fake-agent.js';
import { releaseLock } from '../../src/runtime/lock.js';
import type { PlannerInvocationRequest, PlannerResult } from '../../src/contracts/index.js';
import { createRuntimeCoreTestContainer, type RuntimeCoreTestContainer } from '../../src/runtime/core-composition.js';
import { materializeProjectCard } from '../helpers/materialize-project-card.js';

class CapturingPlannerAdapter extends FakeAgentAdapter {
  capturedPrompt = '';

  invokePlanner(request: PlannerInvocationRequest): PlannerResult;
  invokePlanner(goalId: string, systemPrompt?: string): PlannerResult;
  invokePlanner(requestOrGoalId: PlannerInvocationRequest | string, systemPrompt?: string): PlannerResult {
    this.capturedPrompt = typeof requestOrGoalId === 'string'
      ? systemPrompt ?? ''
      : requestOrGoalId.systemPrompt ?? '';
    return {
      status: 'blocked',
      blocked_reason: 'test planner stopped after prompt capture',
      summary: 'captured prompt',
    };
  }
}

describe('planner prompt context compaction', () => {
  let tmpDir: string;
  let harness: RuntimeCoreTestContainer;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-context-compaction-'));
    mkdirSync(join(tmpDir, 'fixtures'), { recursive: true });
    initProjectTree(tmpDir);
    materializeProjectCard(tmpDir);
  });

  afterEach(async () => {
    if (harness) {
      try { await harness.api.shutdown(); } catch { /* noop */ }
    }
    try { releaseLock(tmpDir); } catch { /* noop */ }
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('summarizes child evidence and long self-report fields instead of embedding artifact-heavy bodies in full', async () => {
    const fixtureDir = join(tmpDir, 'fixtures');
    const fakeAgent = new CapturingPlannerAdapter({ mapping: { project: 'unused' }, fixtureDir });
    harness = createRuntimeCoreTestContainer({
      config: { projectRoot: tmpDir, fakeAgentConfig: { mapping: { project: 'unused' }, fixtureDir } },
      agentRuntime: fakeAgent,
    });

    const longBlob = 'artifact-body-'.repeat(1000);
    harness.cardTestTools.update('project', {
      latest_self_report: {
        summary: longBlob,
        details: { nested: longBlob },
      },
      lifecycle: { status: 'backlog', result: null, error: null, completed_at: null },
    });
    harness.cardTestTools.create({
      type: 'code',
      parent: 'project',
      depth: 1,
      title: 'Heavy child',
      description: 'child with bulky evidence',
      status: 'done',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'planner',
      depends_on: [],
      related: [],
      blocks: [],
      artifacts: Array.from({ length: 12 }, (_, index) => ({ id: `artifact-${index}`, card_id: 'card-1', type: 'report', description: `${index}:${longBlob}`, path: `.saivage-work/artifacts/${index}.txt`, retain: true, created_at: '2026-06-01T00:00:00.000Z' })),
      attachments: Array.from({ length: 12 }, (_, index) => ({ id: `attachment-${index}`, card_id: 'child-heavy', mime: 'text/plain', title: `${index}:${longBlob}`, path: `.saivage-work/attachments/${index}.txt`, created_at: '2026-06-01T00:00:00.000Z' })),
      acceptance: '',
      retries: 0,
      lifecycle: { status: 'done', result: { kind: 'executor_success', executor: { status: 'completed', summary: longBlob, checklist_results: Array.from({ length: 20 }, (_, index) => ({ item: `item-${index}`, note: longBlob })) }, generated_files: [], verified_at: '2026-06-01T00:00:00.000Z', latest_self_report: { result: 'done', outcome: 'done', summary: longBlob, status_text: 'done', at: '2026-06-01T00:00:00.000Z' }, warnings: [] }, error: null, completed_at: '2026-06-01T00:00:00.000Z' },
    });

    await harness.api.start();
    await harness.dispatchTestTools.dispatchGoal('project');

    expect(fakeAgent.capturedPrompt.length).toBeLessThan(30000);
    expect(fakeAgent.capturedPrompt).toContain('result_summary');
    expect(fakeAgent.capturedPrompt).toContain('omitted_count');
    expect(fakeAgent.capturedPrompt).toContain('[truncated');
    expect(fakeAgent.capturedPrompt).not.toContain(longBlob);
  });
});

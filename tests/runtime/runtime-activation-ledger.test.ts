import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { CardStore } from '../../src/utils/card-store.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { appendRuntimeRun, readRuntimeState } from '../../src/runtime/state.js';

function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-activation-'));
  initProjectTree(projectRoot);
  const cardStore = new CardStore(projectRoot);
  cardStore.create({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: '', status: 'active', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  cardStore.create({ id: 'code-a', type: 'code', parent: 'goal-a', depth: 2, title: 'Code A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  return { projectRoot, cardStore };
}

describe('runtime activation ledger target contract (Wave 1)', () => {
  it('only an active parent planner run can activate a child card', async () => {
    const ctx = setup();
    try {
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore });
      const msg = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: 'code-a' }), parentCardId: 'goal-a', sessionId: 'planner:goal-a' });
      expect(msg.kind).toBe('tool_error');
      const body = JSON.parse(msg.content);
      expect(body.actionable_error.code).toBe('activate_card_parent_not_active');
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('duplicate activate_card calls return the same unresolved activation record without orphan child runs', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: 'goal-a', parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:goal-a', result: null });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore });
      const invocation = { toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: 'code-a' }), parentCardId: 'goal-a', sessionId: 'planner:goal-a' };
      const first = JSON.parse((await exec.execute(invocation)).content);
      const second = JSON.parse((await exec.execute(invocation)).content);
      expect(first.success).toBe(true);
      expect(second.success).toBe(true);
      expect(second.activation.activation_id).toBe(first.activation.activation_id);
      expect(second.activation.runtime_run_id).toBe(first.activation.runtime_run_id);

      const state = readRuntimeState(ctx.projectRoot)!;
      const activations = state.runtime_activations ?? [];
      const childRuns = (state.runtime_runs ?? []).filter((run) => run.kind === 'child' && run.card_id === 'code-a' && run.parent_run_id === 'run-parent');
      expect(activations).toHaveLength(1);
      expect(childRuns).toHaveLength(1);
      expect(activations[0].runtime_run_id).toBe(childRuns[0].run_id);
      expect(first.activation.runtime_run_id).toBe(childRuns[0].run_id);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });
});

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

  it('duplicate activate_card calls return the same unresolved activation record', async () => {
    const ctx = setup();
    try {
      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: 'goal-a', parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:goal-a', result: null });
      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore });
      const invocation = { toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: 'code-a' }), parentCardId: 'goal-a', sessionId: 'planner:goal-a' };
      const first = JSON.parse((await exec.execute(invocation)).content);
      const second = JSON.parse((await exec.execute(invocation)).content);
      expect(first.success).toBe(true);
      expect(second.activation.activation_id).toBe(first.activation.activation_id);
      expect(readRuntimeState(ctx.projectRoot)!.runtime_activations).toHaveLength(1);
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });
});

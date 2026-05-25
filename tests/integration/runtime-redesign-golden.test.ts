import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ANALYST_TOOL_NAMES } from '../../src/agents/analyst-tool-schemas.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-llm-resolver.js';
import { PlannerControlExecutor } from '../../src/agents/planner-control-executor.js';
import { operatorApiContracts } from '../../src/contracts/operator-api.js';
import { Runtime } from '../../src/runtime/runtime.js';
import { appendRuntimeRun, readRuntimeState } from '../../src/runtime/state.js';
import { CardStore } from '../../src/cards/card-store.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';

function tempRoot(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }

function setupCards() {
  const projectRoot = tempRoot('saivage-runtime-golden-');
  initProjectTree(projectRoot);
  const cardStore = new CardStore(projectRoot);
  cardStore.create({ id: 'goal-a', type: 'goal', parent: 'project', depth: 1, title: 'Goal A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  cardStore.create({ id: 'code-a', type: 'code', parent: 'goal-a', depth: 2, title: 'Code A', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'planner', depends_on: [], related: [], blocks: [], artifacts: [], attachments: [], acceptance: '', retries: 0 });
  return { projectRoot, cardStore };
}

describe('runtime redesign final golden behavior', () => {
  it('active backend APIs expose explicit start_project/stop_project and no lets_dance or directive wakeup root kickoff', async () => {
    const projectRoot = tempRoot('saivage-runtime-golden-start-');
    try {
      expect('runtime.startProject' in operatorApiContracts).toBe(false);
      expect('runtime.stopProject' in operatorApiContracts).toBe(false);
      expect(ANALYST_TOOL_NAMES).not.toContain('lets_dance');
      expect(Object.keys(TOOL_REGISTRY)).not.toContain('lets_dance');
      expect('requestProjectDirectiveWakeup' in Runtime.prototype).toBe(false);

      const runtime = new Runtime({ projectRoot, fakeAgentConfig: { mapping: {}, fixtureDir: '' }, autoDispatchBacklog: false });
      const dispatched: string[] = [];
      runtime.dispatchGoal = (async (goalId: string) => { dispatched.push(goalId); }) as Runtime['dispatchGoal'];
      const result = await runtime.startProject('operator');
      expect(result.success).toBe(true);
      const state = readRuntimeState(projectRoot)!;
      expect(state.runtime_intent?.status).toBe('running');
      expect(state.runtime_commands).toEqual(expect.arrayContaining([expect.objectContaining({ command: 'start_project', status: 'completed' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'root', card_id: 'project' })]));
      expect(dispatched).toEqual(['project']);
    } finally { rmSync(projectRoot, { recursive: true, force: true }); }
  });

  it('status changes cannot auto-dispatch root or child work; child work requires activate_card from an active parent run', async () => {
    const ctx = setupCards();
    try {
      ctx.cardStore.update('code-a', { status: 'active' });
      expect(readRuntimeState(ctx.projectRoot)?.runtime_runs ?? []).toHaveLength(0);

      const exec = new PlannerControlExecutor({ projectRoot: ctx.projectRoot, cardStore: ctx.cardStore });
      const rejected = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: 'code-a' }), parentCardId: 'goal-a', sessionId: 'planner:goal-a' });
      expect(rejected.kind).toBe('tool_error');
      expect(JSON.parse(rejected.content).actionable_error.code).toBe('activate_card_parent_not_active');
      expect(readRuntimeState(ctx.projectRoot)?.runtime_runs ?? []).toHaveLength(0);

      appendRuntimeRun(ctx.projectRoot, { run_id: 'run-parent', kind: 'root', card_id: 'goal-a', parent_run_id: null, command_id: 'cmd-a', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner:goal-a', result: null });
      const accepted = await exec.execute({ toolName: 'activate_card', toolCallId: 'call-a', argumentsJson: JSON.stringify({ cardId: 'code-a' }), parentCardId: 'goal-a', sessionId: 'planner:goal-a' });
      expect(accepted.kind).toBe('tool_result');
      const body = JSON.parse(accepted.content);
      expect(body.success).toBe(true);
      const state = readRuntimeState(ctx.projectRoot)!;
      expect(state.runtime_activations).toEqual(expect.arrayContaining([expect.objectContaining({ child_card_id: 'code-a', parent_run_id: 'run-parent' })]));
      expect(state.runtime_runs).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'child', card_id: 'code-a', parent_run_id: 'run-parent' })]));
    } finally { rmSync(ctx.projectRoot, { recursive: true, force: true }); }
  });

  it('runtime summaries use command/run/activation records rather than status-derived ready queue APIs', () => {
    expect('buildReadyQueue' in Runtime.prototype).toBe(false);
    expect('getReadyQueue' in Runtime.prototype).toBe(false);
  });

  it('confirmed and preview_hash are scoped to preview tools, not card mutation gates', () => {
    expect('cards.create' in operatorApiContracts).toBe(false);
    expect('cards.update' in operatorApiContracts).toBe(false);
  });

  it('active docs and prompts teach Runtime Console versus Planning Tree and no obsolete execution ritual remains active', () => {
    const activeFiles = [
      'docs/agents.md',
      'docs/analyst.md',
      'docs/goal-planning-runtime.md',
      'docs/operation.md',
      'docs/v3-planner-control-mcp-contract.md',
      'docs/runbook/operations.md',
      'src/agents/system-prompt.ts',
      'src/agents/analyst-llm-resolver.ts',
      'src/agents/analyst-tool-schemas.ts',
    ];
    const combined = activeFiles.map((file) => readFileSync(file, 'utf-8')).join('\n');
    expect(combined).toContain('start_project');
    expect(combined).toContain('stop_project');
    expect(combined).toContain('activate_card');
    expect(combined).toContain('Runtime Console');
    expect(combined).toContain('Planning Tree');
    expect(combined).toMatch(/status[^.]+not[^.]+execution trigger|status[^.]+never an execution trigger|status changes?[^.]+never enqueue/i);
    expect(combined).toMatch(/confirmed[`\w\s/]*and[`\w\s/]*preview_hash|preview_hash[`\w\s/]*.*confirmed/i);
    expect(combined).not.toMatch(/lets_dance/);
    expect(combined).not.toMatch(/project-directive/);
    expect(combined).not.toMatch(/pending-confirmation/);
    expect(combined).not.toMatch(/ready queue/i);
  });
});

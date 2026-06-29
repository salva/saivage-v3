import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  appendRuntimeRun,
  readRuntimeState,
  upsertRuntimeActivation,
} from '../../src/runtime/state.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { synthesizeReportGoalEnvelope } from '../../src/agents/planner-envelope-tracker.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';
import type { NewCardInput } from '../../src/cards/lifecycle.js';
import { AgentToolCatalog } from '../../src/agents/agent-tool-catalog.js';
import { PlannerToolsService } from '../../src/tools/planner-tools.js';

function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) =>
      appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) =>
      upsertRuntimeActivation(projectRoot, input),
  };
}

function createMinimalAdapter(tmpDir: string, cardStore: CardStore): AgentAdapter {
  const minimalConfig = {
    providers: {},
    models: { routes: [] },
    server: { port: 8080, host: '0.0.0.0' },
    runtime: {
      compactionThreshold: 0.8,
      maxCompactions: 3,
      recoveryDelayMs: 60000,
      maxRecoveryRetries: 3,
      selfCheck: { planner: 0, executor: 0, reviewer: 0, analyst: 0 },
    },
    security: {},
    supervisor: {},
  } as unknown as import('../../src/agents/config-schema.js').SaivageConfig;

  return new AgentAdapter({
    projectRoot: tmpDir,
    saivageDir: join(tmpDir, '.saivage'),
    config: minimalConfig,
    activationLedger: activationLedger(tmpDir),
    cardStore,
  });
}

function makeCard(
  overrides: Partial<NewCardInput> & { type: NewCardInput['type']; title: string },
): NewCardInput & {
  id?: string;
} {
  return {
    parent: 'project',
    depth: 1,
    brief: overrides.title,
    status: 'backlog',
    subtype: null,
    tags: [],
    priority: 0,
    urgency: 'normal',
    created_by: 'planner',
    assigned_to: null,
    depends_on: [],
    related: [],
    lifecycle: {
      status: overrides.status ?? 'backlog',
      result: null,
      error: null,
      completed_at: null,
    } as CardRecord['lifecycle'],
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: null,
    status_text_updated_at: null,
    status_text_author_session_id: null,
    latest_self_report: null,
    retries: 0,
    ...overrides,
  };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function processToolCallHandledPlannerTools(): string[] {
  return AgentToolCatalog.roleToolNames('planner');
}

describe('AgentAdapter planner tool surface', () => {
  let tmpDir: string;
  let adapter: AgentAdapter;
  let store: CardStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'saivage-planner-surface-'));
    mkdirSync(join(tmpDir, '.saivage'), { recursive: true });
    initProjectTree(tmpDir);
    store = new CardStore(tmpDir);
    adapter = createMinimalAdapter(tmpDir, store);
    store.create(makeCard({ type: 'project', parent: null, depth: 0, title: 'project' }));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('keeps exported planner tools aligned with processToolCall routing', () => {
    const TERMINAL_TOOLS = new Set([
      'emit_planner_result',
      'emit_executor_result',
      'emit_reviewer_result',
    ]);
    const exportedToolNames = adapter
      .getToolNamesForRole('planner')
      .filter((n) => !TERMINAL_TOOLS.has(n));
    const handledToolNames = processToolCallHandledPlannerTools().filter(
      (n) => !TERMINAL_TOOLS.has(n),
    );

    expect(unique(exportedToolNames)).toEqual(unique(handledToolNames));
  });

  it('keeps the exported planner tool definition order stable for prompt reproducibility', () => {
    const toolNames = adapter.getToolNamesForRole('planner');
    expect(toolNames).toEqual([
      'create_card',
      'edit_card',
      'reorder_child',
      'queue_notification',
      'list_cards',
      'get_card',
      'get_tree',
      'list_card_history',
      'get_card_history_entry',
      'diff_card',
      'read',
      'write',
      'glob',
      'grep',
      'edit',
      'wait_for_process',
      'kill_process',
      'start_and_wait',
      'run_project_command',
      'websearch',
      'webfetch',
      'activate_card',
      'cancel_card',
      'delete_card',
      'restart_card',
      'report_goal_done',
      'report_goal_failed',
      'report_goal_blocked',
    ]);
  });

  it('requires status_text on all report_goal_* definitions', () => {
    const plannerTools = (adapter as any).buildToolsForRole('planner');
    for (const toolName of ['report_goal_done', 'report_goal_failed', 'report_goal_blocked']) {
      const tool = plannerTools.find(
        (entry: { function: { name: string; parameters: { required?: string[] } } }) =>
          entry.function.name === toolName,
      );
      expect(tool).toBeDefined();
      expect(tool.function.parameters.required).toEqual(['status_text']);
      expect(tool.function.parameters.properties).not.toHaveProperty('goalId');
    }
  });

  it('advertises scoped planner card schemas without parent or move_card', () => {
    const plannerTools = (adapter as any).buildToolsForRole('planner');
    expect(
      plannerTools.map((entry: { function: { name: string } }) => entry.function.name),
    ).not.toContain('move_card');
    const create = plannerTools.find(
      (entry: { function: { name: string } }) => entry.function.name === 'create_card',
    );
    const reorder = plannerTools.find(
      (entry: { function: { name: string } }) => entry.function.name === 'reorder_child',
    );
    expect(create.function.parameters.properties).not.toHaveProperty('parent');
    expect(reorder.function.parameters.properties).not.toHaveProperty('parentId');
  });

  it('returns activate_card as a durable activation record without deferred payload', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal A' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Code A', parent: goal.id, depth: 2 }),
    );
    appendRuntimeRun(tmpDir, {
      run_id: 'run-parent',
      kind: 'root',
      ownership: { kind: 'direct', source: 'project_root' }, card_id: goal.id,
      parent_run_id: null,
      command_id: 'cmd-parent',
      activation_id: null,
      phase: 'planner',
      runtime_status: 'running',
      session_id: 'planner-session',
    });
    const result = await (adapter as any).processToolCall(
      {
        id: 'call-activate',
        type: 'function',
        function: { name: 'activate_card', arguments: JSON.stringify({ cardId: child.id }) },
      },
      'planner',
      'planner-session',
      { goalId: goal.id, cardId: goal.id },
    );
    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'activate_card',
      tool_call_id: 'call-activate',
    });
    const body = JSON.parse(result.content);
    expect(body.deferred).toBeUndefined();
    expect(body.activation).toEqual(
      expect.objectContaining({
        parent_run_id: 'run-parent',
        parent_session_id: 'planner-session',
        child_card_id: child.id,
        status: 'pending',
      }),
    );
    expect(readRuntimeState(tmpDir)?.runtime_activations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ activation_id: body.activation.activation_id }),
      ]),
    );
    expect(store.read(child.id)?.status).toBe('backlog');
  });

  it('advertises cancel_card as destructive cleanup/recovery rather than scheduling', () => {
    const plannerTools = (adapter as any).buildToolsForRole('planner');
    const cancelDefinition = plannerTools.find(
      (entry: { function: { name: string } }) => entry.function.name === 'cancel_card',
    );
    expect(cancelDefinition).toBeDefined();
    expect(cancelDefinition.function.description).toContain('Destructively cancel');
    expect(cancelDefinition.function.description).toContain('not a scheduling/defer primitive');
    expect(cancelDefinition.function.description).toContain('actionable backlog work');
  });

  it('advertises planner delete_card only with the planner-control cardId schema', () => {
    const runtimeDeleteDefinitions = (adapter as any).toolRuntime
      .schema()
      .filter((entry: { function: { name: string } }) => entry.function.name === 'delete_card');
    expect(runtimeDeleteDefinitions).toHaveLength(0);

    const plannerTools = (adapter as any).buildToolsForRole('planner');
    const deleteDefinitions = plannerTools.filter(
      (entry: { function: { name: string } }) => entry.function.name === 'delete_card',
    );
    expect(deleteDefinitions).toHaveLength(1);
    expect(deleteDefinitions[0].function.parameters).toEqual(
      expect.objectContaining({
        required: ['cardId'],
        properties: expect.objectContaining({
          cardId: expect.objectContaining({ type: 'string' }),
        }),
      }),
    );
    expect(deleteDefinitions[0].function.parameters.properties).not.toHaveProperty('id');
  });

  it('routes planner delete_card through planner-control with the advertised cardId argument', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal' }));
    const card = store.create(
      makeCard({
        type: 'code',
        title: 'Card to delete',
        status: 'backlog',
        parent: goal.id,
        depth: 2,
      }),
    );
    const result = await (adapter as any).processToolCall(
      {
        id: 'call-delete',
        type: 'function',
        function: { name: 'delete_card', arguments: JSON.stringify({ cardId: card.id }) },
      },
      'planner',
      'planner-session',
      { goalId: goal.id, cardId: goal.id },
    );
    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'delete_card',
      tool_call_id: 'call-delete',
    });
    expect(JSON.parse(result.content)).toEqual(
      expect.objectContaining({ success: true, deleted: true, cardId: card.id }),
    );
    expect(store.read(card.id)).toBeNull();
  });

  it('delegates planner-control tools through the facade while preserving policy gating', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal for cancellation' }));
    const child = store.create(
      makeCard({ type: 'code', title: 'Child for cancellation', parent: goal.id, depth: 2 }),
    );
    const result = await (adapter as any).processToolCall(
      {
        id: 'call-cancel',
        type: 'function',
        function: { name: 'cancel_card', arguments: JSON.stringify({ cardId: child.id }) },
      },
      'planner',
      'planner-session',
      { goalId: goal.id, cardId: goal.id },
    );
    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'cancel_card',
      tool_call_id: 'call-cancel',
    });
    expect(JSON.parse(result.content)).toEqual(
      expect.objectContaining({
        success: true,
        card: expect.objectContaining({ id: child.id, status: 'cancelled' }),
      }),
    );
  });

  it('allows the advertised planner edit_card tool on the runtime surface', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal' }));
    const card = store.create(
      makeCard({
        type: 'code',
        title: 'Editable child',
        status: 'backlog',
        parent: goal.id,
        depth: 2,
      }),
    );
    const result = await (adapter as any).processToolCall(
      {
        id: 'call-edit',
        type: 'function',
        function: { name: 'edit_card', arguments: JSON.stringify({ id: card.id, priority: 5 }) },
      },
      'planner',
      'planner-session',
      { goalId: goal.id, cardId: goal.id },
    );
    expect(result).toMatchObject({
      role: 'tool',
      kind: 'tool_result',
      tool: 'edit_card',
      tool_call_id: 'call-edit',
    });
    expect(JSON.parse(result.content)).toEqual(expect.objectContaining({ success: true }));
    expect(store.read(card.id)?.priority).toBe(5);
  });

  it('hard-errors non-authoritative planner tool names', async () => {
    const result = await (adapter as any).processToolCall(
      {
        id: 'call-unknown',
        type: 'function',
        function: { name: 'set_status_text', arguments: '{}' },
      },
      'planner',
      'planner-session',
      { goalId: 'project', cardId: 'project' },
    );
    expect(result.kind).toBe('tool_error');
    expect(JSON.parse(result.content)).toEqual({ success: false, error: "Unknown tool 'set_status_text'." });
  });
});

describe('synthesizeReportGoalEnvelope', () => {
  it('maps report_goal_* accepted statuses to planner envelopes', () => {
    expect(synthesizeReportGoalEnvelope('report_goal_done', 'goal-1', 'done')).toEqual({
      kind: 'result',
      payload: {
        status: 'done',
        summary: 'report_goal_done accepted for goal goal-1.',
      },
    });

    expect(synthesizeReportGoalEnvelope('report_goal_blocked', 'goal-1', 'blocked')).toEqual({
      kind: 'result',
      payload: {
        status: 'blocked',
        blocked_reason: 'report_goal_blocked accepted with goal status blocked.',
        summary: 'report_goal_blocked accepted for goal goal-1.',
      },
    });

    expect(synthesizeReportGoalEnvelope('report_goal_failed', 'goal-1', 'failed')).toEqual({
      kind: 'result',
      payload: {
        status: 'blocked',
        blocked_reason: 'report_goal_failed accepted with goal status failed.',
        summary: 'report_goal_failed accepted for goal goal-1.',
      },
    });

    expect(synthesizeReportGoalEnvelope('report_goal_done', 'goal-1', 'running')).toEqual({
      kind: 'result',
      payload: {
        status: 'done',
        summary: 'report_goal_done accepted for goal goal-1.',
      },
    });
    expect(synthesizeReportGoalEnvelope('report_goal_blocked', 'goal-1', 'running')).toBeNull();
  });
});

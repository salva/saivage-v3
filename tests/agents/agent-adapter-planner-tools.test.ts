import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { parseDeferredActivationEnvelope } from '../../src/schemas/validators.js';
import { appendRuntimeRun, readRuntimeState, upsertRuntimeActivation } from '../../src/runtime/state.js';
import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';
import { AgentToolCatalog } from '../../src/agents/agent-tool-catalog.js';


function activationLedger(projectRoot: string) {
  return {
    readState: () => readRuntimeState(projectRoot),
    appendRun: (input: Parameters<typeof appendRuntimeRun>[1]) => appendRuntimeRun(projectRoot, input),
    upsertActivation: (input: Parameters<typeof upsertRuntimeActivation>[1]) => upsertRuntimeActivation(projectRoot, input),
  };
}

function createMinimalAdapter(tmpDir: string): AgentAdapter {
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
  });
}

function makeCard(overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string }): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq' | 'position'> & { id?: string } {
  return { parent: 'project', depth: 1, description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'planner', assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function plannerToolNamesFromAgentsDoc(): string[] {
  const docs = readFileSync(join(process.cwd(), 'docs', 'agents.md'), 'utf-8');
  const section = docs.match(/## 7\. Planner Tools(?<body>[\s\S]*?)### 7\.1 Destructive Card Operations/);
  if (!section?.groups?.body) throw new Error('Unable to find docs/agents.md §7 Planner Tools section.');
  const names = [...section.groups.body.matchAll(/^- `([a-z_]+)(?:\(|`)/gm)].map((match) => match[1]);
  if (names.length === 0) throw new Error('Unable to extract any planner tools from docs/agents.md §7.');
  return unique(names);
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
    adapter = createMinimalAdapter(tmpDir);
    store = new CardStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('matches docs/agents.md §7 planner tools to exported definitions and processToolCall routing', () => {
    const documentedToolNames = plannerToolNamesFromAgentsDoc();
    const exportedToolNames = adapter.getToolNamesForRole('planner');
    const handledToolNames = processToolCallHandledPlannerTools();

    expect(exportedToolNames).toEqual(expect.arrayContaining(documentedToolNames));
    expect(documentedToolNames).toEqual(expect.arrayContaining(exportedToolNames));
    expect(handledToolNames).toEqual(expect.arrayContaining(documentedToolNames));
  });

  it('keeps the exported planner tool definition order stable for prompt reproducibility', () => {
    const toolNames = adapter.getToolNamesForRole('planner');
    expect(toolNames).toEqual([
      'create_card', 'edit_card', 'move_card', 'reorder_child', 'queue_notification', 'list_cards', 'get_card', 'get_tree',
      'list_card_history', 'get_card_history_entry', 'diff_card',
      'list_project_files', 'read_project_file', 'write_project_file', 'wait_for_process',
      'kill_process', 'start_and_wait', 'run_project_command',
      'activate_card', 'cancel_card', 'delete_card', 'restart_card',
      'report_goal_done', 'report_goal_failed', 'report_goal_blocked',
    ]);
  });

  it('requires status_text on all report_goal_* definitions', () => {
    const plannerTools = (adapter as any).buildToolsForRole('planner');
    for (const toolName of ['report_goal_done', 'report_goal_failed', 'report_goal_blocked']) {
      const tool = plannerTools.find((entry: { function: { name: string; parameters: { required?: string[] } } }) => entry.function.name === toolName);
      expect(tool).toBeDefined();
      expect(tool.function.parameters.required).toEqual(expect.arrayContaining(['goalId', 'status_text']));
    }
  });

  it('returns activate_card as a durable activation record with deferred compatibility payload', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal A' }));
    appendRuntimeRun(tmpDir, { run_id: 'run-parent', kind: 'root', card_id: goal.id, parent_run_id: null, command_id: 'cmd-parent', activation_id: null, phase: 'planner', runtime_status: 'running', session_id: 'planner-session', result: null });
    const result = await (adapter as any).processToolCall({ id: 'call-activate', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: goal.id }) } }, 'planner', 'planner-session', { goalId: goal.id, cardId: goal.id });
    expect(result).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'activate_card', tool_call_id: 'call-activate' });
    const body = JSON.parse(result.content);
    expect(body.activation).toEqual(expect.objectContaining({ parent_run_id: 'run-parent', parent_session_id: 'planner-session', child_card_id: goal.id, status: 'pending' }));
    expect(parseDeferredActivationEnvelope(body.deferred)).toEqual(expect.objectContaining({ kind: 'deferred_activate_card', parent_card_id: goal.id, child_card_id: goal.id, planner_session_id: 'planner-session', tool_call_id: 'call-activate' }));
    expect(readRuntimeState(tmpDir)?.runtime_activations).toEqual(expect.arrayContaining([expect.objectContaining({ activation_id: body.activation.activation_id })]));
    expect(store.read(goal.id)?.status).toBe('backlog');
  });


  it('advertises planner delete_card only with the planner-control cardId schema', () => {
    const runtimeDeleteDefinitions = (adapter as any).toolRuntime.schema().filter((entry: { function: { name: string } }) => entry.function.name === 'delete_card');
    expect(runtimeDeleteDefinitions).toHaveLength(0);

    const plannerTools = (adapter as any).buildToolsForRole('planner');
    const deleteDefinitions = plannerTools.filter((entry: { function: { name: string } }) => entry.function.name === 'delete_card');
    expect(deleteDefinitions).toHaveLength(1);
    expect(deleteDefinitions[0].function.parameters).toEqual(expect.objectContaining({
      required: ['cardId'],
      properties: expect.objectContaining({ cardId: expect.objectContaining({ type: 'string' }) }),
    }));
    expect(deleteDefinitions[0].function.parameters.properties).not.toHaveProperty('id');
  });

  it('routes planner delete_card through planner-control with the advertised cardId argument', async () => {
    const card = store.create(makeCard({ type: 'code', title: 'Card to delete', status: 'backlog' }));
    const result = await (adapter as any).processToolCall({ id: 'call-delete', type: 'function', function: { name: 'delete_card', arguments: JSON.stringify({ cardId: card.id }) } }, 'planner', 'planner-session', { goalId: card.id, cardId: card.id });
    expect(result).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'delete_card', tool_call_id: 'call-delete' });
    expect(JSON.parse(result.content)).toEqual(expect.objectContaining({ success: true, deleted: true, cardId: card.id }));
    expect(store.read(card.id)).toBeNull();
  });

  it('delegates planner-control tools through the facade while preserving policy gating', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal for cancellation' }));
    const result = await (adapter as any).processToolCall({ id: 'call-cancel', type: 'function', function: { name: 'cancel_card', arguments: JSON.stringify({ cardId: goal.id }) } }, 'planner', 'planner-session', { goalId: goal.id, cardId: goal.id });
    expect(result).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'cancel_card', tool_call_id: 'call-cancel' });
    expect(JSON.parse(result.content)).toEqual(expect.objectContaining({ success: true, card: expect.objectContaining({ id: goal.id, status: 'cancelled' }) }));
  });

  it('hard-errors non-authoritative planner tool names', async () => {
    const result = await (adapter as any).processToolCall({ id: 'call-unknown', type: 'function', function: { name: 'set_status_text', arguments: '{}' } }, 'planner', 'planner-session', { goalId: 'project', cardId: 'project' });
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'set_status_text'");
  });
});

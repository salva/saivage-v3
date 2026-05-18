import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { rmSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { AgentAdapter } from '../../src/agents/agent-adapter.js';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import type { CardRecord } from '../../src/schemas/types.js';
import { PlannerToolError, PlannerToolsService } from '../../src/utils/planner-tools.js';

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
  });
}

function makeCard(overrides: Partial<CardRecord> & { type: CardRecord['type']; title: string }): Omit<CardRecord, 'created_at' | 'updated_at' | 'id' | 'version_seq'> & { id?: string } {
  return { parent: 'project', depth: 1, description: '', status: 'backlog', subtype: null, instructions_file: null, tags: [], priority: 0, urgency: 'normal', created_by: 'planner', assigned_to: null, depends_on: [], blocks: [], related: [], acceptance: '', result: null, metrics: null, artifacts: [], attachments: [], estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, retries: 0, ...overrides };
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

  it('exposes exactly the authoritative docs §7 planner tool list', () => {
    const toolNames = adapter.getToolNamesForRole('planner');
    expect(toolNames).toEqual([
      'create_card', 'edit_card', 'add_note', 'list_cards', 'get_card', 'get_tree',
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

  it('returns activate_card as a deferred unresolved tool result envelope', async () => {
    const goal = store.create(makeCard({ type: 'goal', title: 'Goal A' }));
    const result = await (adapter as any).processToolCall({ id: 'call-activate', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ cardId: goal.id }) } }, 'planner', 'planner-session', { goalId: goal.id, cardId: goal.id });
    expect(result).toMatchObject({ role: 'tool', kind: 'tool_result', tool: 'activate_card', tool_call_id: 'call-activate' });
    expect(JSON.parse(result.content)).toEqual({ __saivage_defer_tool_result: true, cardId: goal.id });
    expect(store.read(goal.id)?.status).toBe('backlog');
  });

  it('hard-errors non-authoritative planner tool names', async () => {
    const result = await (adapter as any).processToolCall({ id: 'call-unknown', type: 'function', function: { name: 'set_status_text', arguments: '{}' } }, 'planner', 'planner-session', { goalId: 'project', cardId: 'project' });
    expect(result.kind).toBe('tool_error');
    expect(result.content).toContain("Unknown planner tool 'set_status_text'");
  });
});

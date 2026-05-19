import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { getNotes } from '../../src/utils/notes.js';
import { readProjectDirectives } from '../../src/utils/analyst-stage6.js';
import { TOOL_REGISTRY } from '../../src/agents/analyst-llm-resolver.js';
import type { ToolContext, ToolResult } from '../../src/agents/analyst-tools.js';

let root: string;
let store: CardStore;

function saivageDir(): string { return join(root, '.saivage'); }

function ctx(): ToolContext {
  return { projectRoot: root, store, actor: 'analyst', surface: 'web-chat' };
}

async function confirmedTool(tool: string, params: Record<string, unknown>): Promise<ToolResult> {
  const preview = await TOOL_REGISTRY[tool](ctx(), params);
  expect(preview.success).toBe(true);
  expect(preview.preview?.preview_hash).toEqual(expect.any(String));
  return TOOL_REGISTRY[tool](ctx(), { ...params, confirmed: true, preview_hash: preview.preview!.preview_hash });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-analyst-directives-'));
  initProjectTree(root);
  store = new CardStore(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('analyst directive tool end-to-end registry path', () => {
  it('lets_dance persists a project directive with project-card context', async () => {
    const result = await TOOL_REGISTRY.lets_dance(ctx(), {});

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(result.data).toEqual(expect.objectContaining({ directive_recorded: true, runtime_status: 'idle' }));
    expect(readProjectDirectives(root).lets_dance).toEqual(expect.any(String));
    const notes = getNotes(saivageDir(), 'project').filter((note) => note.kind === 'directive');
    expect(notes).toEqual(expect.arrayContaining([
      expect.objectContaining({ author: 'analyst', content: expect.stringContaining('lets_dance directive recorded') }),
    ]));
  });

  it('mark_goal_needs_corrections persists directive notes with origin and ancestor card context', async () => {
    store.create({ id: 'goal-parent', type: 'goal', parent: 'project', depth: 1, title: 'parent', description: '', status: 'running', tags: [], priority: 10, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
    store.create({ id: 'goal-child', type: 'goal', parent: 'goal-parent', depth: 2, title: 'child', description: '', status: 'done', tags: [], priority: 10, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });

    const result = await confirmedTool('mark_goal_needs_corrections', {
      goalId: 'goal-child',
      issues: [{ summary: 'planner missed acceptance check', severity: 'warning' }],
      note: 'Synthetic operator correction note.',
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(result.data).toEqual(expect.objectContaining({
      origin_goal_id: 'goal-child',
      status_transition: { from: 'done', to: 'changed' },
    }));
    expect(new Set((result.data as { notes_recorded_on_goal_ids: string[] }).notes_recorded_on_goal_ids)).toEqual(new Set(['goal-child', 'goal-parent', 'project']));
    for (const cardId of ['goal-child', 'goal-parent', 'project']) {
      expect(getNotes(saivageDir(), cardId)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          author: 'analyst',
          kind: 'directive',
          content: expect.stringContaining('pending_subtree_correction from goal-child: planner missed acceptance check'),
        }),
      ]));
    }
  });

  it('mark_project_needs_corrections persists a project-level directive with sanitized project context', async () => {
    const result = await confirmedTool('mark_project_needs_corrections', {
      issues: [{ summary: 'project plan needs another pass', severity: 'blocker', evidence_path: 'synthetic/report.md' }],
      note: 'Synthetic note with token=abc123 should be redacted.',
    });

    expect(result).toEqual(expect.objectContaining({ success: true }));
    expect(result.data).toEqual(expect.objectContaining({ directive_recorded: true, runtime_status: 'idle' }));
    expect(readProjectDirectives(root).project_needs_corrections).toEqual(expect.any(String));
    const projectNotes = getNotes(saivageDir(), 'project').filter((note) => note.content.includes('project_needs_corrections'));
    expect(projectNotes).toHaveLength(1);
    expect(projectNotes[0]).toEqual(expect.objectContaining({ author: 'analyst', kind: 'directive' }));
    expect(projectNotes[0]!.content).toContain('project plan needs another pass');
    expect(projectNotes[0]!.content).not.toContain('abc123');
  });
});

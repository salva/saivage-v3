import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';
import { createSession, getSessionMessages } from '../../src/agents/session-persistence.js';
import { getNotes } from '../../src/utils/notes.js';
import { initRuntimeState, updateRuntimeState } from '../../src/utils/runtime-state.js';
import { consumeChangedCardActivation, injectQueuedSyntheticPlannerNotes, markDescendantChanged, markGoalNeedsCorrections, recordLetsDanceDirective, recordProjectNeedsCorrectionsDirective } from '../../src/utils/analyst-stage6.js';

let root: string;
let store: CardStore;

function saivageDir(): string { return join(root, '.saivage'); }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'saivage-stage6-'));
  initProjectTree(root);
  store = new CardStore(root);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function createGoal(id: string, parent: string, status: 'backlog' | 'running' | 'done' | 'blocked' | 'changed' = 'backlog') {
  return store.create({ id, type: 'goal', parent, depth: 0, title: id, description: '', status, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
}

function createCode(id: string, parent: string, status: 'backlog' | 'changed' = 'backlog') {
  return store.create({ id, type: 'code', parent, depth: 0, title: id, description: '', status, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 });
}

describe('stage-6 analyst synthetic notes', () => {
  it('routes to the deepest containing planner and delivers exactly once for a Running target planner', () => {
    createGoal('goal-parent', 'project', 'running');
    createGoal('goal-child', 'goal-parent', 'running');
    createCode('code-leaf', 'goal-child');
    createSession(saivageDir(), 'planner', 'goal-parent', 'goal-parent');
    const child = createSession(saivageDir(), 'planner', 'goal-child', 'goal-child');

    markDescendantChanged(root, 'code-leaf', 'operator edited implementation');
    expect(injectQueuedSyntheticPlannerNotes(root, child.id)).toBe(1);
    expect(getSessionMessages(saivageDir(), child.id).at(-1)?.content).toContain('subtree_changed for code-leaf');
    expect(injectQueuedSyntheticPlannerNotes(root, child.id)).toBe(0);
  });

  it('delivers queued notes for AwaitingChild active planner on runtime resume', () => {
    createGoal('goal-parent', 'project', 'running');
    createGoal('goal-child', 'goal-parent');
    const parent = createSession(saivageDir(), 'planner', 'goal-parent', 'goal-parent');
    initRuntimeState(root);
    updateRuntimeState(root, { status: 'running', active_card_run: { card_id: 'goal-child', card_type: 'goal', runtime_status: 'running', phase: 'planner', caller_session_id: parent.id, caller_tool_call_id: 'call-1', planner_session_id: parent.id, correction_attempts: 0, started_at: new Date().toISOString(), last_turn_at: new Date().toISOString() } });

    markGoalNeedsCorrections(root, 'goal-child', [{ summary: 'child contract drifted', severity: 'warning' }]);
    expect(injectQueuedSyntheticPlannerNotes(root, parent.id)).toBe(2);
    expect(getSessionMessages(saivageDir(), parent.id).at(-1)?.content).toContain('pending_subtree_correction');
  });

  it('keeps Dormant planner notes queued until the planner is resumed', () => {
    createGoal('goal-parent', 'project', 'backlog');
    createCode('code-leaf', 'goal-parent');
    store.update('goal-parent', { status: 'done' });
    const planner = createSession(saivageDir(), 'planner', 'goal-parent', 'goal-parent');
    markDescendantChanged(root, 'code-leaf', 'dormant subtree edit');
    expect(getSessionMessages(saivageDir(), planner.id)).toHaveLength(0);
    expect(injectQueuedSyntheticPlannerNotes(root, planner.id)).toBe(1);
    expect(getSessionMessages(saivageDir(), planner.id).at(-1)?.content).toContain('dormant subtree edit');
  });

  it('activate_card changed consumption keeps queued subtree_changed notes for one-shot planner delivery', () => {
    createGoal('goal-parent', 'project', 'running');
    createGoal('other-goal', 'project', 'running');
    createCode('code-leaf', 'goal-parent');
    createCode('other-leaf', 'other-goal');
    const planner = createSession(saivageDir(), 'planner', 'goal-parent', 'goal-parent');
    const otherPlanner = createSession(saivageDir(), 'planner', 'other-goal', 'other-goal');
    markDescendantChanged(root, 'code-leaf', 'changed before activation');
    markDescendantChanged(root, 'other-leaf', 'unrelated change');
    expect(store.read('code-leaf')?.status).toBe('changed');

    const removed = consumeChangedCardActivation(root, 'code-leaf');

    expect(removed).toBeGreaterThan(0);
    expect(new CardStore(root).read('code-leaf')?.status).toBe('running');
    expect(getNotes(saivageDir(), 'goal-parent').filter((note) => !note.handled && note.content.includes('subtree_changed') && note.content.includes('code-leaf')).length).toBe(0);
    expect(getNotes(saivageDir(), 'other-goal').filter((note) => !note.handled && note.content.includes('subtree_changed') && note.content.includes('other-leaf')).length).toBe(1);

    expect(injectQueuedSyntheticPlannerNotes(root, planner.id)).toBe(1);
    expect(getSessionMessages(saivageDir(), planner.id).at(-1)?.content).toContain('subtree_changed for code-leaf');
    expect(injectQueuedSyntheticPlannerNotes(root, planner.id)).toBe(0);

    expect(injectQueuedSyntheticPlannerNotes(root, otherPlanner.id)).toBe(1);
    expect(getSessionMessages(saivageDir(), otherPlanner.id).at(-1)?.content).toContain('subtree_changed for other-leaf');
  });

  it('records lets_dance and project correction directives idempotently', () => {
    initRuntimeState(root);
    expect(recordLetsDanceDirective(root)).toEqual({ directive_recorded: true, runtime_status: 'idle' });
    expect(recordLetsDanceDirective(root)).toEqual({ directive_recorded: true, runtime_status: 'idle' });
    expect(getNotes(saivageDir(), 'project').filter((note) => note.content.includes('lets_dance')).length).toBe(1);
    recordProjectNeedsCorrectionsDirective(root, [{ summary: 'fix project', evidence_path: '/tmp/.env' }], 'token=secret');
    recordProjectNeedsCorrectionsDirective(root, [{ summary: 'fix project again' }]);
    const projectNotes = getNotes(saivageDir(), 'project').filter((note) => note.content.includes('project_needs_corrections'));
    expect(projectNotes).toHaveLength(1);
    expect(projectNotes[0].content).not.toContain('token=secret');
  });
});

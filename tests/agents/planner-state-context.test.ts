import { describe, expect, it } from '@jest/globals';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPlannerStateContextText, type PlannerStateCardStore } from '../../src/agents/planner-state-context.js';
import type { CardRecord } from '../../src/schemas/index.js';

const timestamp = '2026-07-08T00:00:00.000Z';

function makeCard(overrides: Partial<CardRecord> & Pick<CardRecord, 'id' | 'type' | 'parent' | 'depth' | 'position' | 'title'>): CardRecord {
  return {
    id: overrides.id,
    type: overrides.type,
    parent: overrides.parent,
    depth: overrides.depth,
    position: overrides.position,
    title: overrides.title,
    status: overrides.status ?? 'backlog',
    lifecycle: overrides.lifecycle ?? { status: 'backlog', result: null, error: null, completed_at: null },
    subtype: overrides.subtype ?? null,
    tags: overrides.tags ?? [],
    priority: overrides.priority ?? 0,
    urgency: overrides.urgency ?? 'normal',
    created_by: overrides.created_by ?? 'planner',
    created_at: overrides.created_at ?? timestamp,
    updated_at: overrides.updated_at ?? timestamp,
    version_seq: overrides.version_seq ?? 1,
    assigned_to: overrides.assigned_to ?? null,
    depends_on: overrides.depends_on ?? [],
    related: overrides.related ?? [],
    metrics: overrides.metrics ?? null,
    estimate: overrides.estimate ?? null,
    started_at: overrides.started_at ?? null,
    duration_ms: overrides.duration_ms ?? null,
    status_text: overrides.status_text ?? null,
    status_text_updated_at: overrides.status_text_updated_at ?? null,
    status_text_author_session_id: overrides.status_text_author_session_id ?? null,
    latest_self_report: overrides.latest_self_report ?? null,
    metadata: overrides.metadata ?? null,
    allowedActions: overrides.allowedActions ?? [],
    retries: overrides.retries ?? 0,
  };
}

function extractState(text: string): Record<string, unknown> {
  const match = text.match(/```json\n([\s\S]*?)\n```/);
  if (!match) throw new Error('planner state context must include a JSON code block');
  return JSON.parse(match[1]) as Record<string, unknown>;
}

function writeBriefRecord(projectRoot: string, cardId: string, content: string): void {
  const dir = join(projectRoot, '.saivage/outputs/cards', cardId, 'brief');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.json'), `${JSON.stringify({ slot: 'brief', latest: 1, open: null, versions: { '1': { status: 'closed' } } }, null, 2)}\n`);
  writeFileSync(join(dir, '1.md'), content);
}

describe('buildPlannerStateContextText', () => {
  it('labels normal planner context as a state snapshot instead of compaction', () => {
    const goal = makeCard({ id: 'G-1', type: 'goal', parent: 'project', depth: 1, position: 0, title: 'Ship feature' });
    const child = makeCard({ id: 'C-1', type: 'code', parent: goal.id, depth: 2, position: 0, title: 'Implement feature' });
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-planner-state-context-'));
    writeBriefRecord(projectRoot, goal.id, 'Goal brief');
    writeBriefRecord(projectRoot, child.id, 'Child brief');
    const cards = new Map<string, CardRecord>([[goal.id, goal], [child.id, child]]);
    const store: PlannerStateCardStore = {
      read: (id) => cards.get(id) ?? null,
      listChildren: (id) => (id === goal.id ? [child.id] : []),
    };

    const text = buildPlannerStateContextText({
      projectRoot,
      sessionId: 'planner:G-1',
      goalId: goal.id,
      cardStore: store,
      runtimeStateProvider: () => null,
    });

    expect(text).toContain('## Current Planner State Snapshot');
    expect(text).toContain('reconstructed authoritative state for the current goal at activation start');
    expect(text).toContain('Existing direct children are authoritative');
    expect(text).not.toMatch(/Current Planner State \(compact(ed)? turn\)/);
    expect(text).not.toMatch(/^## Current Planner State.*compact/im);
    expect(text).not.toMatch(/^This is .*compact/im);

    const state = extractState(text);
    expect(state.session_id).toBe('planner:G-1');
    expect(state.goal_id).toBe(goal.id);
    expect(state.direct_children).toEqual(expect.arrayContaining([expect.objectContaining({ id: child.id, title: child.title })]));
    expect(state.candidate_next_action).toEqual(expect.objectContaining({ kind: 'activate_child' }));
  });
});

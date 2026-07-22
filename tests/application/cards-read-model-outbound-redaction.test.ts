import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CardsReadModelService } from '../../src/application/read-models/cards-read-model.js';
import { buildCardRunsResponse } from '../../src/application/read-models/runtime-card-runs-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { CardHistoryEntry, CardRecord, RuntimeState } from '../../src/schemas/index.js';
import { createCardHistoryProvider } from '../../src/tools/card-history-provider.js';
import { createCardInspectionProvider } from '../../src/tools/card-inspection-provider.js';
import { buildInvocationSurface, invokeTool } from '../../src/tools/invocation.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { OUTBOUND_IDENTITY, OUTBOUND_RAW_MARKER, OUTBOUND_TEXT_MARKER } from '../helpers/outbound-identity-fixtures.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('typed card outbound owners across REST, runtime, and built-in tools', () => {
  it('preserves credential-shaped structure and redacts every current card prose field consistently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-outbound-'));
    roots.push(root);
    initProjectTree(root);
    const project = card({ id: 'project', type: 'project', title: 'Project', children: ['card-token'], tags: [] });
    const parent = card({ id: 'card-token', title: `title ${OUTBOUND_TEXT_MARKER}`, children: ['card-token-a'], tags: [OUTBOUND_IDENTITY] });
    const child = card({ id: 'card-token-a', title: `child ${OUTBOUND_TEXT_MARKER}`, children: [], tags: [OUTBOUND_IDENTITY] });
    const entry = historyEntry(parent);
    const diff = [
      { field: 'tags', before: ['tok_primary'], after: ['tok_primary', 'sk-model'] },
      { field: 'title', before: 'before token=diff-before-secret', after: 'after token=diff-after-secret' },
      { field: 'lifecycle', before: parent.lifecycle, after: parent.lifecycle },
      { field: 'status_text', before: 'token=diff-status-before', after: 'token=diff-status-after' },
      { field: 'pending_notifications', before: parent.pending_notifications, after: child.pending_notifications },
    ];
    const cards = new Map([[project.id, project], [parent.id, parent], [child.id, child]]);
    const store = {
      getCardDetail: (id: string) => id === parent.id ? { kind: 'found', value: parent } : { kind: 'card-not-found' },
      getCardChildren: (id: string) => id === parent.id ? { kind: 'found', value: { parent, activeChildren: [child] } } : { kind: 'card-not-found' },
      listCardHistory: (id: string) => id === parent.id ? { kind: 'found', value: [entry] } : { kind: 'card-not-found' },
      getCardHistoryEntry: (id: string, seq: number) => id === parent.id && seq === 7 ? { kind: 'found', value: entry } : { kind: 'history-entry-not-found', versionSeq: seq },
      diffCardHistory: (id: string) => id === parent.id ? { kind: 'found', from: 7, to: 8, diff } : { kind: 'card-not-found' },
      read: (id: string) => cards.get(id) ?? null,
      listChildren: (id: string) => cards.get(id)?.children ?? [],
      getAncestors: (id: string) => id === parent.id ? ['project'] : [],
    };
    const readModel = new CardsReadModelService(root, store as never, { getRuntimeState: () => null });

    const detail = readModel.getCard(parent.id).body as { card: CardRecord & { allowedActions: string[]; operator_summary: { blocked: boolean; hasError: boolean; error: string | null; stale: boolean } } };
    const children = readModel.getChildren(parent.id).body as { card: CardRecord; children: CardRecord[] };
    assertProjectedCard(detail.card);
    expect(detail.card).toMatchObject({
      created_by: 'planner', urgency: 'critical', priority: 3, allowedActions: ['card.cancel', 'card.delete'],
      operator_summary: { blocked: true, hasError: true, error: 'token=[REDACTED]', stale: false },
    });
    assertProjectedCard(children.card);
    expect(children.children[0]).toMatchObject({ id: 'card-token-a', tags: [OUTBOUND_IDENTITY], title: 'child token=[REDACTED]' });

    const historyList = readModel.listHistory(parent.id).body as { history: Array<Record<string, unknown>> };
    expect(historyList.history[0]).toMatchObject({
      entry_id: entry.entry_id, card_id: 'card-token', kind: 'update', changed_by_actor: 'planner', changed_by_surface: 'runtime',
      changed_fields: ['title', 'tags'], change_reason: 'token=[REDACTED]', change_summary: 'token=[REDACTED]',
    });
    const history = (readModel.getHistoryEntry(parent.id, 7).body as { entry: CardHistoryEntry }).entry;
    assertProjectedCard(history.snapshot);
    const projectedDiff = (readModel.diffCard(parent.id, { from: 7, to: 8 }).body as { diff: typeof diff }).diff;
    expect(projectedDiff[0]).toEqual({ field: 'tags', before: ['tok_primary'], after: ['tok_primary', 'sk-model'] });
    expect(projectedDiff[1]).toEqual({ field: 'title', before: 'before token=[REDACTED]', after: 'after token=[REDACTED]' });
    expect(projectedDiff[3]).toEqual({ field: 'status_text', before: 'token=[REDACTED]', after: 'token=[REDACTED]' });
    const projectedNotifications = projectedDiff[4] as { field: 'pending_notifications'; before: CardRecord['pending_notifications']; after: CardRecord['pending_notifications'] };
    expect(projectedNotifications.before[0]).toMatchObject({ id: 'sk-notification', source: 'tok_primary', content: 'token=[REDACTED]' });

    appendConversationBatch({ projectRoot: root }, [{
      id: 'sk-message', session_id: 'planner:project', role: 'user', kind: 'text', content: 'plan',
      round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp,
    }]);
    const state: RuntimeState = { status: 'running', project_id: 'project', pid: 42, started_at: timestamp, current_card_id: 'card-token', updated_at: timestamp };
    const runs = buildCardRunsResponse(root, store as never, { getRuntimeState: () => state });
    expect(runs).toEqual({
      current_card_id: 'card-token',
      active_breadcrumb: [
        { card_id: 'project', card_type: 'project', title: 'Project' },
        { card_id: 'card-token', card_type: 'code', title: 'title token=[REDACTED]', status_text: 'token=[REDACTED]' },
      ],
      dormant_planners: [{ goal_card_id: 'project', planner_session_id: 'planner:project' }],
    });

    const cardSurface = buildInvocationSurface('analyst', [createCardInspectionProvider({ store })]);
    const listed = await invokeTool(cardSurface, 'list_cards', { tag: OUTBOUND_IDENTITY });
    expect(listed).toMatchObject({ success: true, data: [
      { id: 'card-token', tags: ['tok_primary'], title: 'title token=[REDACTED]', logical_path: 'Project / title token=[REDACTED]' },
      { id: 'card-token-a', tags: ['tok_primary'], title: 'child token=[REDACTED]', logical_path: 'Project / title token=[REDACTED] / child token=[REDACTED]' },
    ] });
    const got = await invokeTool(cardSurface, 'get_card', { id: 'card-token' });
    expect(got.success).toBe(true);
    assertProjectedCard((got.data as { card: CardRecord }).card);

    const historySurface = buildInvocationSurface('analyst', [createCardHistoryProvider({ store: store as never })]);
    const toolList = await invokeTool(historySurface, 'list_card_history', { cardId: 'card-token' });
    expect(toolList).toMatchObject({ success: true, data: [expect.objectContaining({ card_id: 'card-token', change_reason: 'token=[REDACTED]', changed_fields: ['title', 'tags'] })] });
    const toolEntry = await invokeTool(historySurface, 'get_card_history_entry', { cardId: 'card-token', version_seq: 7 });
    assertProjectedCard((toolEntry.data as CardHistoryEntry).snapshot);
    const toolDiff = await invokeTool(historySurface, 'diff_card', { cardId: 'card-token', fromSeq: 7, toSeq: 8 });
    expect((toolDiff.data as { diff: typeof diff }).diff[0]).toEqual(projectedDiff[0]);
    expect(JSON.stringify({ detail, children, runs, listed, history, projectedDiff })).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('fails fast on an unknown card diff field', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-outbound-'));
    roots.push(root);
    const store = {
      diffCardHistory: () => ({ kind: 'found', from: 1, to: 2, diff: [{ field: 'future_field', before: 'a', after: 'b' }] }),
    };
    const readModel = new CardsReadModelService(root, store as never, { getRuntimeState: () => null });
    expect(() => readModel.diffCard('card-token', { from: 1, to: 2 })).toThrow(/Unknown card diff field/);
  });
});

const timestamp = '2026-07-22T12:00:00.000Z';

function card(overrides: Partial<CardRecord> & Pick<CardRecord, 'id' | 'title' | 'children' | 'tags'>): CardRecord {
  return {
    id: overrides.id,
    type: overrides.type ?? 'code',
    children: overrides.children,
    title: overrides.title,
    lifecycle: overrides.id === 'project' ? { status: 'backlog', result: null, error: null, completed_at: null } : {
      status: 'blocked',
      result: { kind: 'blocked', summary: 'token=lifecycle-summary-secret', resume_reason: 'token=resume-secret', blocker_cause: 'generic' },
      error: 'token=lifecycle-error-secret', completed_at: null,
    },
    subtype: null,
    tags: overrides.tags,
    priority: 3,
    urgency: 'critical',
    created_by: 'planner',
    created_at: timestamp,
    updated_at: timestamp,
    version_seq: 7,
    assigned_to: null,
    depends_on: overrides.id === 'project' ? [] : ['card-sk'],
    related: overrides.id === 'project' ? [] : ['card-rt'],
    metrics: null,
    estimate: null,
    started_at: null,
    duration_ms: null,
    status_text: overrides.id === 'project' ? null : 'token=status-secret',
    status_text_updated_at: overrides.id === 'project' ? null : timestamp,
    status_text_author_session_id: null,
    latest_self_report: null,
    metadata: null,
    pending_notifications: overrides.id === 'project' ? [] : [{ id: 'sk-notification', content: 'token=notification-secret', created_at: timestamp, source: 'tok_primary' }],
  };
}

function historyEntry(snapshot: CardRecord): CardHistoryEntry {
  return {
    entry_id: '11111111-1111-4111-8111-111111111111', kind: 'update', card_id: snapshot.id, version_seq: 7,
    snapshot, changed_at: timestamp, changed_by_actor: 'planner', changed_by_surface: 'runtime',
    change_reason: 'token=history-reason-secret', changed_fields: ['title', 'tags'], change_summary: 'token=history-summary-secret',
  };
}

function assertProjectedCard(card: CardRecord & { operator_summary?: { error: string | null } }): void {
  expect(card).toMatchObject({
    id: 'card-token', type: 'code', children: ['card-token-a'], tags: ['tok_primary'], depends_on: ['card-sk'], related: ['card-rt'],
    title: 'title token=[REDACTED]', status_text: 'token=[REDACTED]',
    lifecycle: {
      status: 'blocked', result: { kind: 'blocked', summary: 'token=[REDACTED]', resume_reason: 'token=[REDACTED]', blocker_cause: 'generic' },
      error: 'token=[REDACTED]', completed_at: null,
    },
    pending_notifications: [{ id: 'sk-notification', content: 'token=[REDACTED]', created_at: timestamp, source: 'tok_primary' }],
  });
  if (card.operator_summary) expect(card.operator_summary.error).toBe('token=[REDACTED]');
}

import { describe, expect, it } from '@jest/globals';
import { selectLinkedRunningChain } from '../../src/runtime/running-card-chain.js';
import type { CardRecord } from '../../src/schemas/index.js';

function card(id: string, type: CardRecord['type'], status: 'running' | 'stopped', children: string[] = []): CardRecord {
  return { id, type, children, title: id, subtype: null, tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: '2026-07-20T00:00:00.000Z', updated_at: '2026-07-20T00:00:00.000Z', version_seq: 1, assigned_to: null, depends_on: [], related: [], lifecycle: { status, result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null, status_text: null, status_text_updated_at: null, status_text_author_session_id: null, latest_self_report: null, metadata: null, pending_notifications: [] };
}

describe('running card restart selection', () => {
  it('selects the unique deepest running leaf', () => {
    const code = card('card-a-b', 'code', 'running');
    const goal = card('card-a', 'goal', 'running', [code.id]);
    const root = card('project', 'project', 'running', [goal.id]);
    expect(selectLinkedRunningChain(reader([code, root, goal])).map((entry) => entry.id)).toEqual([root.id, goal.id, code.id]);
  });

  it('rejects branching running sets', () => {
    const left = card('card-a', 'goal', 'running');
    const right = card('card-b', 'goal', 'running');
    const root = card('project', 'project', 'running', [left.id, right.id]);
    expect(() => selectLinkedRunningChain(reader([root, left, right]))).toThrow('more than one running direct child');
  });

  it('excludes stopped linked history from active chain membership', () => {
    const stopped = card('card-a', 'goal', 'stopped');
    const root = card('project', 'project', 'running', [stopped.id]);
    expect(selectLinkedRunningChain(reader([root, stopped])).map((entry) => entry.id)).toEqual(['project']);
    expect(selectLinkedRunningChain(reader([card('project', 'project', 'stopped', [stopped.id]), stopped]))).toEqual([]);
  });

  it('rejects a running descendant below a stopped root', () => {
    const child = card('card-a', 'goal', 'running');
    const root = card('project', 'project', 'stopped', [child.id]);
    expect(() => selectLinkedRunningChain(reader([root, child]))).toThrow("Linked running card 'card-a' is outside the unique project-rooted running chain.");
  });

  it('rejects a running descendant below a stopped intermediate ancestor', () => {
    const leaf = card('card-a-b', 'code', 'running');
    const stopped = card('card-a', 'goal', 'stopped', [leaf.id]);
    const root = card('project', 'project', 'running', [stopped.id]);
    expect(() => selectLinkedRunningChain(reader([root, stopped, leaf]))).toThrow("Linked running card 'card-a-b' is outside the unique project-rooted running chain.");
  });

  it('retains a valid stopped-descendant partial recovery prefix', () => {
    const stoppedLeaf = card('card-a-b', 'code', 'stopped');
    const runningGoal = card('card-a', 'goal', 'running', [stoppedLeaf.id]);
    const root = card('project', 'project', 'running', [runningGoal.id]);
    expect(selectLinkedRunningChain(reader([root, runningGoal, stoppedLeaf])).map((entry) => entry.id)).toEqual(['project', 'card-a']);
  });

  it('retains strict missing-child and structural parent validation across stopped history', () => {
    const rootWithMissing = card('project', 'project', 'stopped', ['card-a']);
    expect(() => selectLinkedRunningChain(reader([rootWithMissing]))).toThrow("Linked child 'card-a' of 'project' is missing.");

    const misplaced = card('card-a-b', 'code', 'stopped');
    const rootWithMisplaced = card('project', 'project', 'stopped', [misplaced.id]);
    expect(() => selectLinkedRunningChain(reader([rootWithMisplaced, misplaced]))).toThrow("Linked child 'card-a-b' does not name 'project' as its parent.");
  });
});

function reader(cards: readonly CardRecord[]) {
  const byId = new Map(cards.map((entry) => [entry.id, entry]));
  return { read: (id: string) => byId.get(id) ?? null, listChildren: (id: string) => byId.get(id)?.children ?? [] };
}

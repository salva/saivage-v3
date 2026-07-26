import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildContentPolicyReadModel } from '../../src/application/read-models/content-policy-read-model.js';
import { readCanonicalLinkedCardHistoryTree } from '../../src/persistence/card-files.js';
import { CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY } from '../../src/schemas/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'content-policy-history-'));
  roots.push(root);
  initProjectTree(root);
  return { root, cards: new CardService(root) };
}
function childInput(parent = 'project', title = 'child', type: 'goal' | 'code' = 'code') {
  return { type, parent, title, bootstrap_content: `${title} brief`, tags: [], priority: 0, urgency: 'normal' as const, created_by: 'analyst' as const, depends_on: [], related: [] };
}
function block(cards: CardService, id: string, markerId: string, at: string): void {
  cards.setStatus(id, 'running');
  const result = { kind: 'content-policy-refusal' as const, summary: CONTENT_POLICY_REFUSAL_BLOCKED_SUMMARY, session_id: `agent:executor:${id}` as const, marker_id: markerId, evidence_url: `/agents/${encodeURIComponent(`agent:executor:${id}`)}?entry=${encodeURIComponent(markerId)}` };
  cards.commitActivationOutcome(id, { status: 'blocked', summary: result.summary, result }, at);
}

describe('content-policy linked history read model', () => {
  it('reads each reached stream once and pairs terminal history with its resulting blocked card', () => {
    const { root, cards } = setup();
    const child = cards.create(childInput('project', 'child', 'goal'));
    const grandchild = cards.create(childInput(child.id, 'grandchild'));
    block(cards, child.id, 'marker-child', '2026-07-26T01:00:00.000Z');
    block(cards, grandchild.id, 'marker-grandchild', '2026-07-26T02:00:00.000Z');
    const reads: string[] = [];
    const tree = readCanonicalLinkedCardHistoryTree(root, { onRead: (path) => reads.push(path) });
    expect(reads).toHaveLength(3);
    expect(new Set(reads).size).toBe(3);
    const blockedPair = tree.find(({ current }) => current.id === child.id)!.versions.find(({ resultingCard }) => resultingCard.lifecycle.status === 'blocked')!;
    expect(blockedPair.history).toMatchObject({ kind: 'terminal', snapshot: { lifecycle: { status: 'running' } } });
    expect(blockedPair.resultingCard.lifecycle.status).toBe('blocked');
    expect(blockedPair.version).toBe(blockedPair.resultingCard.version_seq);
  });

  it('counts retained reopened and reached tombstoned refusal versions and stops below tombstones', () => {
    const { root, cards } = setup();
    const child = cards.create(childInput('project', 'child', 'goal'));
    const grandchild = cards.create(childInput(child.id, 'grandchild'));
    block(cards, child.id, 'marker-child', '2026-07-26T01:00:00.000Z');
    cards.setStatus(child.id, 'changed');
    block(cards, grandchild.id, 'marker-grandchild', '2026-07-26T02:00:00.000Z');
    cards.deleteSubtrees([child.id], () => true);
    const model = buildContentPolicyReadModel(root);
    expect(model).toEqual({
      refusal_high_water: 1,
      latest: { card_id: child.id, session_id: `agent:executor:${child.id}`, marker_id: 'marker-child', evidence_url: `/agents/${encodeURIComponent(`agent:executor:${child.id}`)}?entry=marker-child`, blocked_at: expect.any(String) },
    });
    const terminal = readCanonicalLinkedCardHistoryTree(root).find(({ current }) => current.id === child.id)!.versions.find(({ resultingCard }) => resultingCard.lifecycle.status === 'blocked')!;
    expect(model.latest!.blocked_at).toBe(terminal.history!.changed_at);
  });
});

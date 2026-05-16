import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/utils/file-tree.js';
import { CardStore } from '../../src/utils/card-store.js';

let root: string;
let store: CardStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'card-history-'));
  initProjectTree(root);
  store = new CardStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function createCard() {
  return store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', description: 'desc', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: 'a', artifacts: [], attachments: [], retries: 0, instructions_file: null, subtype: null, assigned_to: null, result: null, metrics: null, estimate: null, started_at: null, completed_at: null, duration_ms: null, error: null });
}

describe('card history substrate', () => {
  it('new cards start at version 1 with no history', () => {
    const card = createCard();
    expect(card.version_seq).toBe(1);
    expect(store.listCardHistory(card.id)).toEqual([]);
  });

  it('tracked edit increments version and snapshots pre-edit card', () => {
    const card = createCard();
    const updated = store.mutateCard(card.id, { description: 'new desc', acceptance: 'new a' }, { actor: 'analyst', surface: 'web-chat', reason: 'edit' });
    const history = store.listCardHistory(card.id);
    expect(updated.version_seq).toBe(2);
    expect(history).toHaveLength(1);
    expect(history[0].snapshot).toEqual(card);
    expect(history[0].version_seq).toBe(1);
    expect(history[0].changed_fields.sort()).toEqual(['acceptance', 'description']);
  });

  it('untracked edit does not increment version or append history', () => {
    const card = createCard();
    const updated = store.setStatus(card.id, 'active');
    expect(updated.version_seq).toBe(1);
    expect(store.listCardHistory(card.id)).toEqual([]);
  });

  it('getCardAt and diffCard return correct versions and changes', () => {
    const card = createCard();
    store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    const v3 = store.mutateCard(card.id, { tags: ['x'], priority: 4 }, { actor: 'planner', surface: 'runtime' });
    expect(store.getCardAt(card.id, 1).title).toBe('Goal');
    expect(store.getCardAt(card.id, 2).title).toBe('Goal 2');
    expect(store.getCardAt(card.id, v3.version_seq)).toEqual(v3);
    expect(store.diffCard(card.id, 1, 3).map((d) => d.field).sort()).toEqual(['priority', 'tags', 'title', 'updated_at', 'version_seq']);
  });

  it('drops orphan history line on reopen after injected pre-rename failure', () => {
    const card = createCard();
    const crashyStore = new CardStore(root, undefined, {
      beforeTrackedCardRename: () => {
        throw new Error('boom');
      },
    });
    expect(() => crashyStore.mutateCard(card.id, { title: 'boom' }, { actor: 'analyst', surface: 'web-chat' })).toThrow('boom');
    const reopened = new CardStore(root);
    const current = reopened.read(card.id)!;
    expect(current.version_seq).toBe(1);
    expect(reopened.listCardHistory(card.id)).toEqual([]);
    const historyFilePath = join(root, '.saivage', 'cards', 'history', `${card.id}.history.jsonl`);
    expect(readFileSync(historyFilePath, 'utf-8')).toBe('');
  });
});

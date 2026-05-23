import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { CardStore } from '../../src/cards/card-store.js';
import type { CardHistoryEntry } from '../../src/schemas/types.js';

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

  it('getCardAt and diffCard survive reopen with correct versions and changes', () => {
    const card = createCard();
    store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    const v3 = store.mutateCard(card.id, { tags: ['x'], priority: 4 }, { actor: 'planner', surface: 'runtime' });

    const reopened = new CardStore(root);
    expect(reopened.getCardAt(card.id, 1).title).toBe('Goal');
    expect(reopened.getCardAt(card.id, 2).title).toBe('Goal 2');
    expect(reopened.getCardAt(card.id, v3.version_seq)).toEqual(v3);
    expect(reopened.diffCard(card.id, 1, 3).map((d) => d.field).sort()).toEqual(['priority', 'tags', 'title', 'updated_at', 'version_seq']);
    const history = reopened.listCardHistory(card.id);
    expect(Math.max(...history.map((entry) => entry.version_seq))).toBe(v3.version_seq - 1);
  });

  it('drops only trailing orphan history lines on reopen after injected pre-rename failure', () => {
    const card = createCard();
    store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    const crashyStore = new CardStore(root, undefined, {
      beforeTrackedCardRename: () => {
        throw new Error('boom');
      },
    });
    expect(() => crashyStore.mutateCard(card.id, { title: 'boom' }, { actor: 'analyst', surface: 'web-chat' })).toThrow('boom');

    const historyFilePath = join(root, '.saivage', 'cards', 'history', `${card.id}.history.jsonl`);
    const rawBeforeReopen = readFileSync(historyFilePath, 'utf-8').trim().split('\n').filter(Boolean);
    expect(rawBeforeReopen).toHaveLength(2);

    const reopened = new CardStore(root);
    const current = reopened.read(card.id)!;
    const history = reopened.listCardHistory(card.id);
    expect(current.version_seq).toBe(2);
    expect(history).toHaveLength(1);
    expect(history[0].version_seq).toBe(1);
    expect(history[0].snapshot.version_seq).toBe(1);
    expect(reopened.getCardAt(card.id, 1).title).toBe('Goal');
    expect(reopened.getCardAt(card.id, 2).title).toBe('Goal 2');
    expect(reopened.diffCard(card.id, 1, 2).map((entry) => entry.field)).toContain('title');
    const persistedHistory = readFileSync(historyFilePath, 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as CardHistoryEntry);
    expect(Math.max(...persistedHistory.map((entry) => entry.version_seq))).toBe(current.version_seq - 1);
  });

  it('drops trailing orphan history entries whose version_seq is greater than or equal to current version while preserving valid earlier entries', () => {
    const card = createCard();
    const v2 = store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    store.mutateCard(card.id, { description: 'Goal 3 desc' }, { actor: 'analyst', surface: 'web-chat' });

    const historyFilePath = join(root, '.saivage', 'cards', 'history', `${card.id}.history.jsonl`);
    const persistedLines = readFileSync(historyFilePath, 'utf-8').trim().split('\n').filter(Boolean);
    const orphanEntry = {
      ...JSON.parse(persistedLines[1]) as CardHistoryEntry,
      version_seq: 3,
      snapshot: { ...v2, version_seq: 3 },
      changed_fields: ['acceptance'],
      change_summary: 'acceptance updated',
    } satisfies CardHistoryEntry;
    writeFileSync(historyFilePath, `${persistedLines.join('\n')}\n${JSON.stringify(orphanEntry)}\n`, 'utf-8');

    const reopened = new CardStore(root);
    const current = reopened.read(card.id)!;
    const history = reopened.listCardHistory(card.id);
    expect(current.version_seq).toBe(3);
    expect(history).toHaveLength(2);
    expect(history.map((entry) => entry.version_seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(Math.max(...history.map((entry) => entry.version_seq))).toBe(current.version_seq - 1);
    expect(reopened.getCardAt(card.id, 1).title).toBe('Goal');
    expect(reopened.getCardAt(card.id, 2).title).toBe('Goal 2');
    expect(reopened.getCardAt(card.id, 3).description).toBe('Goal 3 desc');
  });
});

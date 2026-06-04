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
  return store.create({ type: 'goal', parent: 'project', depth: 1, title: 'Goal', description: 'desc', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], blocks: [], related: [], acceptance: 'a', artifacts: [], attachments: [], retries: 0, instructions_file: null, subtype: null, assigned_to: null, lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, metrics: null, estimate: null, started_at: null, duration_ms: null });
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
    expect(history[0].entry_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(history[0].kind).toBe('mutate');
  });

  it('F13 r5: every accepted patch produces a history entry (status transitions included)', () => {
    const card = createCard();
    const updated = store.setStatus(card.id, 'active');
    expect(updated.version_seq).toBe(2);
    const history = store.listCardHistory(card.id);
    expect(history).toHaveLength(1);
    expect(history[0].kind).toBe('status');
    expect(history[0].changed_fields).toContain('status');
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
    const ids = history.map((e) => e.entry_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('F13 r5: throws loudly on injected orphan history rows (no silent drop)', () => {
    const card = createCard();
    const v2 = store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    store.mutateCard(card.id, { description: 'Goal 3 desc' }, { actor: 'analyst', surface: 'web-chat' });

    const historyFilePath = join(root, '.saivage', 'cards', 'history', `${card.id}.history.jsonl`);
    const persistedLines = readFileSync(historyFilePath, 'utf-8').trim().split('\n').filter(Boolean);
    const orphanEntry = {
      ...JSON.parse(persistedLines[1]) as CardHistoryEntry,
      entry_id: '00000000-0000-4000-8000-000000000001',
      version_seq: 3,
      snapshot: { ...v2, version_seq: 3 },
      changed_fields: ['acceptance'],
      change_summary: 'acceptance updated',
    } satisfies CardHistoryEntry;
    writeFileSync(historyFilePath, `${persistedLines.join('\n')}\n${JSON.stringify(orphanEntry)}\n`, 'utf-8');

    expect(() => new CardStore(root)).toThrow();
  });

  it('F13 r5: throws loudly on injected version_seq===0 history row', () => {
    const card = createCard();
    store.mutateCard(card.id, { title: 'Goal 2' }, { actor: 'analyst', surface: 'web-chat' });
    const historyFilePath = join(root, '.saivage', 'cards', 'history', `${card.id}.history.jsonl`);
    const lines = readFileSync(historyFilePath, 'utf-8').trim().split('\n').filter(Boolean);
    const badEntry = {
      ...JSON.parse(lines[0]) as CardHistoryEntry,
      entry_id: '00000000-0000-4000-8000-000000000002',
      version_seq: 0,
    } satisfies CardHistoryEntry;
    writeFileSync(historyFilePath, `${lines.join('\n')}\n${JSON.stringify(badEntry)}\n`, 'utf-8');
    expect(() => new CardStore(root)).toThrow();
  });
});

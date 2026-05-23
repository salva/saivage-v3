import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/cards/card-store.js';
import { list_card_history, get_card_history_entry, diff_card, list_notes, get_note, type ToolContext } from '../../src/agents/analyst-tools.js';
import { appendNote } from '../../src/cards/notes.js';

function setup(root: string): CardStore {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  return new CardStore(root);
}

function ctx(root: string, store: CardStore): ToolContext { return { projectRoot: root, store, actor: 'executor', surface: 'runtime', sessionId: 'sess-1' }; }

describe('card history and notes tools', () => {
  it('lists history, gets an entry, diffs versions, and reads notes without audit writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-f-history-tools-'));
    try {
      const store = setup(root);
      store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
      store.create({ id: 'code-1', type: 'code', parent: 'goal-1', depth: 0, title: 'before', description: 'old', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: 'a', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
      store.mutateCard('code-1', { title: 'after', acceptance: 'b' }, { actor: 'analyst', surface: 'web-chat', reason: 'operator edit' });
      const note = appendNote(join(root, '.saivage'), 'code-1', { author: 'analyst', content: 'directive body', kind: 'directive' });

      const toolCtx = ctx(root, store);
      const history = await list_card_history(toolCtx, { cardId: 'code-1' });
      expect(history.success).toBe(true);
      expect((history.data as Array<{ version_seq: number }>)).toHaveLength(1);
      expect((history.data as Array<{ version_seq: number }>)[0]?.version_seq).toBe(1);

      const entry = await get_card_history_entry(toolCtx, { cardId: 'code-1', version_seq: 1 });
      expect(entry.success).toBe(true);
      expect((entry.data as { snapshot: { title: string; acceptance: string } }).snapshot.title).toBe('before');
      expect((entry.data as { snapshot: { title: string; acceptance: string } }).snapshot.acceptance).toBe('a');

      const diff = await diff_card(toolCtx, { cardId: 'code-1' });
      expect(diff.success).toBe(true);
      const fields = (diff.data as { diff: Array<{ field: string }> }).diff.map((item) => item.field);
      expect(fields).toEqual(expect.arrayContaining(['acceptance','title']));

      const notes = await list_notes(toolCtx, { cardId: 'code-1' });
      expect(notes.success).toBe(true);
      expect((notes.data as Array<{ id: string }>)).toHaveLength(1);
      const fetched = await get_note(toolCtx, { cardId: 'code-1', noteId: note.id });
      expect(fetched.success).toBe(true);
      expect((fetched.data as { content: string }).content).toBe('directive body');

      const auditPath = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
      expect(existsSync(auditPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

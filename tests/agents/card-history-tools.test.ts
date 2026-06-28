import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/cards/card-store.js';
import { list_card_history, get_card_history_entry, diff_card } from '../../src/tools/analyst-card-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';

function setup(root: string): CardStore {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', lifecycle: { status: 'backlog', result: null, error: null, completed_at: null }, tags: [], priority: 0, position: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], related: [], acceptance: '', retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  return new CardStore(root);
}

function ctx(root: string, store: CardStore): ToolContext { return { projectRoot: root, store, actor: 'executor', surface: 'runtime', sessionId: 'sess-1' }; }

describe('card history and notes tools', () => {
  it('lists history, gets an entry, diffs versions, without audit writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-f-history-tools-'));
    try {
      const store = setup(root);
      const goal = store.create({ type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], related: [], retries: 0 } as any);
      const code = store.create({ type: 'code', parent: goal.id, depth: 0, title: 'before', description: 'old', status: 'backlog', tags: [], priority: 1, position: 0, urgency: 'normal', created_by: 'analyst', acceptance: 'a', depends_on: [], related: [], retries: 0 } as any);
      store.mutateCard(code.id, { title: 'after', acceptance: 'b' }, { actor: 'analyst', surface: 'web-chat', reason: 'operator edit' });
      const toolCtx = ctx(root, store);
      const history = await list_card_history(toolCtx, { cardId: code.id });
      expect(history.success).toBe(true);
      expect((history.data as Array<{ version_seq: number }>)).toHaveLength(1);
      expect((history.data as Array<{ version_seq: number }>)[0]?.version_seq).toBe(1);

      const entry = await get_card_history_entry(toolCtx, { cardId: code.id, version_seq: 1 });
      expect(entry.success).toBe(true);
      expect((entry.data as { snapshot: { title: string; acceptance: string } }).snapshot.title).toBe('before');
      expect((entry.data as { snapshot: { title: string; acceptance: string } }).snapshot.acceptance).toBe('a');

      const diff = await diff_card(toolCtx, { cardId: code.id });
      expect(diff.success).toBe(true);
      const fields = (diff.data as { diff: Array<{ field: string }> }).diff.map((item) => item.field);
      expect(fields).toEqual(expect.arrayContaining(['acceptance','title']));


      const auditPath = join(root, '.saivage', 'runtime', 'control-actions.jsonl');
      expect(existsSync(auditPath)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

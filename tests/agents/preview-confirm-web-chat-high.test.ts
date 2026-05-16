import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/utils/card-store.js';
import { edit_card, type ToolContext } from '../../src/agents/analyst-tools.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';

function setup(root: string): CardStore {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(sd, 'agents', 'sessions', 'sess-1.json'), JSON.stringify({ id: 'sess-1', card_id: 'goal-1', goal_card_id: 'goal-1', role: 'executor', status: 'active', started_at: now, updated_at: now }));
  const store = new CardStore(root);
  store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: 'before', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
  return store;
}

function readAudit(root: string) {
  return readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('preview confirm web-chat high', () => {
  it('preview-only verdict alone drives preview, wrong hash rejection, and confirmed mutation with exactly-one audit per call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-preview-'));
    try {
      const store = setup(root);
      const ctx: ToolContext = { projectRoot: root, store, actor: 'analyst', surface: 'web-chat' };
      const notifications = new NotificationCenter(root);

      const preview = await edit_card(ctx, { id: 'goal-1', acceptance: 'after secret=tok_live_123' });
      expect(preview.success).toBe(true);
      expect(preview.preview?.preview_hash).toBeTruthy();
      expect(store.read('goal-1')?.acceptance).toBe('before');
      expect(store.read('goal-1')?.version_seq).toBe(1);
      expect(notifications.listUnacknowledgedBlockingForSession('sess-1')).toHaveLength(0);

      const wrongHash = await edit_card(ctx, { id: 'goal-1', acceptance: 'after secret=tok_live_123', confirmed: true, preview_hash: 'wrong-hash' });
      expect(wrongHash.success).toBe(true);
      expect(wrongHash.preview?.preview_hash).toBe(preview.preview?.preview_hash);
      expect(store.read('goal-1')?.acceptance).toBe('before');
      expect(store.read('goal-1')?.version_seq).toBe(1);
      expect(notifications.listUnacknowledgedBlockingForSession('sess-1')).toHaveLength(0);

      const confirmed = await edit_card(ctx, { id: 'goal-1', acceptance: 'after secret=tok_live_123', confirmed: true, preview_hash: preview.preview?.preview_hash });
      expect(confirmed.success).toBe(true);
      expect((confirmed.data as { acceptance: string }).acceptance).toBe('after secret=tok_live_123');
      const persisted = new CardStore(root);
      expect(persisted.read('goal-1')?.acceptance).toBe('after secret=tok_live_123');
      expect(persisted.read('goal-1')?.version_seq).toBe(2);
      expect(notifications.listUnacknowledgedBlockingForSession('sess-1')).toHaveLength(1);

      const audit = readAudit(root);
      expect(audit).toHaveLength(3);
      expect(audit.map((entry) => entry.outcome)).toEqual(['rejected', 'rejected', 'ok']);
      for (const entry of audit) {
        expect(entry.action).toBe('card.update');
        expect(entry.params_summary).toContain('[REDACTED]');
        expect(entry.params_summary).not.toContain('tok_live_123');
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

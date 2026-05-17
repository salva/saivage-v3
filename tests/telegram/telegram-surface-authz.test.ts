import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TelegramBot } from '../../src/telegram/bot.js';
import { evaluateAuthz } from '../../src/agents/authz.js';
import { CardStore } from '../../src/utils/card-store.js';
import { delete_card, edit_card, type ToolContext } from '../../src/agents/analyst-tools.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';

function setup(root: string) {
  const sd = join(root, '.saivage');
  for (const d of ['agents/sessions','agents/messages','cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'saivage.json'), JSON.stringify({ telegram: { botToken: 'x', allowedUserIds: [1] }, server: { port: 8080, host: '127.0.0.1' }, models: { default: ['test-model'] }, providers: { test: { priority: 1, models: ['test-model'], apiKey: 'secret' } } }, null, 2));
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(sd, 'agents', 'sessions', 'sess-telegram.json'), JSON.stringify({ id: 'sess-telegram', card_id: 'goal-1', goal_card_id: 'goal-1', role: 'executor', status: 'active', started_at: now, updated_at: now }));
}

describe('telegram surface authz', () => {
  it('preserves telegram verdict differences for high preview-only and destructive deny with no mutation/no notification on deny', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-telegram-'));
    try {
      setup(root);
      const bot = new TelegramBot(root);
      const store = new CardStore(root);
      store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: 'before', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
      const ctx: ToolContext = { projectRoot: root, store, actor: 'analyst', surface: 'telegram' };
      const notifications = new NotificationCenter(root);

      expect(bot.isAuthorized(1)).toBe(true);
      expect(evaluateAuthz({ actor: 'analyst', surface: 'telegram', safety_class: 'high' })).toBe('preview_only');
      expect(evaluateAuthz({ actor: 'analyst', surface: 'telegram', safety_class: 'destructive' })).toBe('deny');
      expect(evaluateAuthz({ actor: 'analyst', surface: 'web-chat', safety_class: 'destructive' })).toBe('preview_only');

      const preview = await edit_card(ctx, { id: 'goal-1', acceptance: 'after telegram token=tg-secret' });
      expect(preview.success).toBe(true);
      expect(preview.preview?.preview_hash).toBeTruthy();
      expect(store.read('goal-1')?.acceptance).toBe('before');

      const denied = await delete_card(ctx, { id: 'goal-1' });
      expect(denied.success).toBe(false);
      expect(denied.error).toMatch(/Denied by authorization policy/);
      expect(store.read('goal-1')?.acceptance).toBe('before');
      expect(notifications.drainPendingForSession('sess-telegram')).toHaveLength(0);

      const audit = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(audit).toHaveLength(2);
      expect(audit[0].outcome).toBe('rejected');
      expect(audit[1].outcome).toBe('denied');
      expect(audit[1].action).toBe('card.delete');
      expect(audit[1].params_summary).not.toContain('tg-secret');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

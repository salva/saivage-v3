import { describe, it, expect } from '@jest/globals';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CardStore } from '../../src/utils/card-store.js';
import { acknowledge_notification, mark_note_handled, type ToolContext } from '../../src/agents/analyst-tools.js';
import { NotificationCenter } from '../../src/utils/notification-center.js';
import { appendNote } from '../../src/utils/notes.js';

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
  const store = new CardStore(root);
  store.create({ id: 'goal-1', type: 'goal', parent: 'project', depth: 0, title: 'goal', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
  store.create({ id: 'code-1', type: 'code', parent: 'goal-1', depth: 0, title: 'task', description: '', status: 'backlog', tags: [], priority: 1, urgency: 'normal', created_by: 'analyst', acceptance: '', depends_on: [], blocks: [], related: [], artifacts: [], attachments: [], retries: 0 });
  return store;
}

function ctx(root: string, store: CardStore, sessionId?: string): ToolContext { return { projectRoot: root, store, actor: 'executor', surface: 'runtime', sessionId }; }

describe('acknowledge_notification', () => {
  it('acknowledges only the calling session notification, returns structured errors, and audits low tools', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-f-ack-'));
    try {
      const store = setup(root);
      const center = new NotificationCenter(root);
      center.enqueueForSession('sess-own', { id: 'n-own', kind: 'card_changed', severity: 'block', payload_summary: 'own', source_actor: 'analyst', source_surface: 'web-chat' });
      center.enqueueForSession('sess-other', { id: 'n-other', kind: 'card_changed', severity: 'block', payload_summary: 'other', source_actor: 'analyst', source_surface: 'web-chat' });
      center.enqueueForOperator({ id: 'n-operator', kind: 'runtime_state', severity: 'info', payload_summary: 'operator', source_actor: 'analyst', source_surface: 'web-ui' });

      const missingSession = await acknowledge_notification({ projectRoot: root, store, actor: 'executor', surface: 'runtime' }, { notificationId: 'n-own' });
      expect(missingSession.success).toBe(false);
      expect(missingSession.error).toBe('acknowledge_notification requires ToolContext.sessionId.');

      const crossSession = await acknowledge_notification(ctx(root, store, 'sess-own'), { notificationId: 'n-other' });
      expect(crossSession.success).toBe(false);
      expect(crossSession.error).toBe("Notification 'n-other' belongs to a different session and cannot be acknowledged by session 'sess-own'.");
      expect(center.listUnacknowledgedBlockingForSession('sess-other')[0]?.acknowledged_at).toBeNull();

      const operatorSurface = await acknowledge_notification(ctx(root, store, 'sess-own'), { notificationId: 'n-operator' });
      expect(operatorSurface.success).toBe(false);
      expect(operatorSurface.error).toBe("Notification 'n-operator' belongs to the operator surface and cannot be acknowledged by session 'sess-own'.");

      const missingId = await acknowledge_notification(ctx(root, store, 'sess-own'), { notificationId: 'n-missing' });
      expect(missingId.success).toBe(false);
      expect(missingId.error).toBe("Notification 'n-missing' does not exist.");

      const own = await acknowledge_notification(ctx(root, store, 'sess-own'), { notificationId: 'n-own' });
      expect(own.success).toBe(true);
      expect((own.data as { acknowledged_at: string }).acknowledged_at).toBeTruthy();

      const note = appendNote(join(root, '.saivage'), 'code-1', { author: 'analyst', content: 'handle me', kind: 'directive' });
      const handled = await mark_note_handled(ctx(root, store, 'sess-own'), { cardId: 'code-1', noteId: note.id });
      expect(handled.success).toBe(true);

      const lines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(6);
      expect(lines.filter((line) => line.action === 'notification.acknowledge')).toHaveLength(5);
      expect(lines.map((line) => line.action)).toEqual(expect.arrayContaining(['notification.acknowledge','note.mark_handled']));
      expect(lines.filter((line) => line.action === 'notification.acknowledge' && line.outcome === 'ok')).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import authPlugin from '../../src/server/auth.js';
import { registerCardRoutes } from '../../src/server/routes/cards.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { NotificationCenter } from '../../src/notifications/notification-center.js';

function setup(root: string) {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime','agents/sessions','agents/messages']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
  writeFileSync(join(sd, 'agents', 'sessions', 'sess-card.json'), JSON.stringify({ id: 'sess-card', card_id: 'goal-1', goal_card_id: 'goal-1', role: 'executor', status: 'active', started_at: now, updated_at: now }));
}

function readAudit(root: string) {
  return readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

describe('card routes authz audit', () => {
  it('rest mutations follow allow verdicts, mutate through canonical services, and redact audit payloads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-card-routes-'));
    process.env['SAIVAGE_API_TOKEN'] = 'x';
    try {
      setup(root);
      const notifications = new NotificationCenter(root);
      const app = Fastify();
      await app.register(authPlugin);
      registerCardRoutes(app, root);
      const headers = { authorization: 'Bearer x' };

      const createRes = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'goal', parent: 'project', title: 'goal', description: 'd' } });
      expect(createRes.statusCode).toBe(201);
      const createdId = (createRes.json() as { card: { id: string } }).card.id;

      const patchRes = await app.inject({ method: 'PATCH', url: `/api/cards/${createdId}`, headers, payload: { acceptance: 'new acceptance apiKey=route-secret' } });
      expect(patchRes.statusCode).toBe(200);
      const patched = JSON.parse(readFileSync(join(root, '.saivage', 'cards', 'by-id', `${createdId}.json`), 'utf-8')) as { acceptance: string; version_seq: number };
      expect(patched.acceptance).toBe('new acceptance apiKey=route-secret');
      expect(patched.version_seq).toBe(2);
      expect(notifications.listUnacknowledgedBlockingForSession('sess-card')).toHaveLength(1);

      const deleteRes = await app.inject({ method: 'DELETE', url: `/api/cards/${createdId}`, headers, payload: {} });
      expect(deleteRes.statusCode).toBe(204);

      const lines = readAudit(root);
      expect(lines).toHaveLength(3);
      expect(lines.map((line) => line.action)).toEqual(['card.create', 'card.update', 'card.delete']);
      expect(lines.map((line) => line.outcome)).toEqual(['ok', 'ok', 'ok']);
      const updateEntry = lines.find((line) => line.action === 'card.update');
      expect(updateEntry?.params_summary).toContain('[REDACTED]');
      expect(updateEntry?.params_summary).not.toContain('route-secret');
      await app.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

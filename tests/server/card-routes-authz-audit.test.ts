import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import authPlugin from '../../src/server/auth.js';
import { registerCardRoutes } from '../../src/server/routes/cards.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function setup(root: string) {
  const sd = join(root, '.saivage');
  for (const d of ['cards/by-id','cards/tree','cards/dependencies','notes/by-card','runtime']) mkdirSync(join(sd, d), { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(sd, 'cards', 'by-id', 'project.json'), JSON.stringify({ id: 'project', type: 'project', parent: null, depth: 0, title: 'project', description: '', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', created_at: now, updated_at: now, version_seq: 1, depends_on: [], blocks: [], related: [], acceptance: '', artifacts: [], attachments: [], retries: 0 }));
  writeFileSync(join(sd, 'cards', 'index.json'), JSON.stringify({ cards: { project: { id: 'project', type: 'project', parent: null, status: 'backlog', title: 'project' } } }));
  writeFileSync(join(sd, 'cards', 'tree', 'project.children.json'), JSON.stringify([]));
  writeFileSync(join(sd, 'cards', 'dependencies', 'depends-on.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'cards', 'dependencies', 'blocks.json'), JSON.stringify({}));
  writeFileSync(join(sd, 'notes', 'queue.json'), JSON.stringify({ next_note_sequence: 1, entries: [] }));
}

describe('card routes authz audit', () => {
  it('writes one audit entry per create update delete outcome', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wave-d-card-routes-'));
    process.env['SAIVAGE_API_TOKEN'] = 'x';
    try {
      setup(root);
      const app = Fastify();
      await app.register(authPlugin);
      registerCardRoutes(app, root);
      const headers = { authorization: 'Bearer x' };

      const createRes = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'goal', parent: 'project', title: 'goal', description: 'd' } });
      expect(createRes.statusCode).toBe(201);
      const createdId = (createRes.json() as { card: { id: string } }).card.id;

      const patchRes = await app.inject({ method: 'PATCH', url: `/api/cards/${createdId}`, headers, payload: { acceptance: 'new acceptance' } });
      expect(patchRes.statusCode).toBe(200);

      const deleteRes = await app.inject({ method: 'DELETE', url: `/api/cards/${createdId}`, headers, payload: {} });
      expect(deleteRes.statusCode).toBe(204);

      const lines = readFileSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'), 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
      expect(lines).toHaveLength(3);
      expect(lines[0].action).toBe('card.create');
      expect(lines[0].outcome).toBe('ok');
      expect(lines[1].action).toBe('card.update');
      expect(lines[1].outcome).toBe('ok');
      expect(lines[2].action).toBe('card.delete');
      expect(lines[2].outcome).toBe('ok');
      await app.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

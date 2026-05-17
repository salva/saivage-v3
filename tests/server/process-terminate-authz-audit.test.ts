import { describe, it, expect } from '@jest/globals';
import Fastify from 'fastify';
import authPlugin from '../../src/server/auth.js';
import { registerProcessRoutes } from '../../src/server/routes/processes.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

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
}

describe('process termination route absence', () => {
  it('does not expose or audit a REST process termination product surface this cycle', async () => {
    const root = mkdtempSync(join(tmpdir(), 'process-route-absence-'));
    process.env['SAIVAGE_API_TOKEN'] = 'x';
    try {
      setup(root);
      const app = Fastify();
      await app.register(authPlugin);
      registerProcessRoutes(app, root);
      const res = await app.inject({ method: 'POST', url: '/api/processes/proc-1/terminate', headers: { authorization: 'Bearer x' }, payload: {} });
      expect(res.statusCode).toBe(404);
      expect(existsSync(join(root, '.saivage', 'runtime', 'control-actions.jsonl'))).toBe(false);
      await app.close();
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

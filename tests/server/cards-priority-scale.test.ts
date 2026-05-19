import { describe, it, expect, afterEach } from '@jest/globals';
import Fastify from 'fastify';
import authPlugin from '../../src/server/auth.js';
import { registerCardRoutes } from '../../src/server/routes/cards.js';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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

async function makeApp(root: string) {
  process.env['SAIVAGE_API_TOKEN'] = 'x';
  setup(root);
  const app = Fastify();
  await app.register(authPlugin);
  registerCardRoutes(app, root);
  return app;
}

describe('card routes priority scale', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
    delete process.env['SAIVAGE_API_TOKEN'];
  });

  it('accepts 0 and 100 priorities on card creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-priority-'));
    roots.push(root);
    const app = await makeApp(root);
    const headers = { authorization: 'Bearer x' };
    const zero = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'code', parent: 'project', title: 'zero', priority: 0 } });
    const hundred = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'code', parent: 'project', title: 'hundred', priority: 100 } });
    expect(zero.statusCode).toBe(201);
    expect((zero.json() as { card: { priority: number } }).card.priority).toBe(0);
    expect(hundred.statusCode).toBe(201);
    expect((hundred.json() as { card: { priority: number } }).card.priority).toBe(100);
    await app.close();
  });

  it('rejects out-of-range priority values on card creation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-card-priority-'));
    roots.push(root);
    const app = await makeApp(root);
    const headers = { authorization: 'Bearer x' };
    const low = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'code', parent: 'project', title: 'low', priority: -1 } });
    const high = await app.inject({ method: 'POST', url: '/api/cards', headers, payload: { type: 'code', parent: 'project', title: 'high', priority: 101 } });
    expect(low.statusCode).toBe(400);
    expect(high.statusCode).toBe(400);
    expect(low.json()).toEqual(expect.objectContaining({ error: 'Card creation failed', message: 'priority must be an integer from 0 to 100' }));
    await app.close();
  });
});

import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initProjectTree } from '../../src/persistence/file-tree.js';
import { writeFileAtomic } from '../../src/persistence/index.js';
import { CardStore } from '../../src/cards/card-store.js';
import { get_card, get_tree } from '../../src/tools/analyst-card-tools.js';
import { registerCardRoutes } from '../../src/server/routes/cards.js';
import type { CardRecord } from '../../src/schemas/types.js';

function makeCard(overrides: Partial<CardRecord> & { type?: CardRecord['type']; title?: string; parent?: string | null } = {}) {
  return {
    type: overrides.type ?? 'code',
    parent: overrides.parent ?? 'project',
    depth: 0,
    title: overrides.title ?? 'Test Card',
    description: '',
    status: 'backlog' as const,
    tags: [],
    priority: 0,
    urgency: 'normal' as const,
    created_by: 'analyst' as const,
    depends_on: [],
    blocks: [],
    related: [],
    acceptance: '',
    artifacts: [],
    attachments: [],
    retries: 0,
    ...(overrides.id ? { id: overrides.id } : {}),
  };
}

function rewritePosition(root: string, id: string, position: number): void {
  const path = join(root, '.saivage', 'cards', 'by-id', `${id}.json`);
  const card = JSON.parse(readFileSync(path, 'utf-8')) as CardRecord;
  writeFileAtomic(path, JSON.stringify({ ...card, position }, null, 2) + '\n');
}

let tmpDir: string;
let app: FastifyInstance;
let baseUrl: string;
let authToken: string;
let parentId: string;
let expectedChildOrder: string[];

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'saivage-shuffled-subtree-'));
  initProjectTree(tmpDir);
  const store = new CardStore(tmpDir);
  const parent = store.create(makeCard({ type: 'goal', title: 'Parent' }));
  const alpha = store.create(makeCard({ type: 'goal', title: 'Alpha', parent: parent.id }));
  const beta = store.create(makeCard({ type: 'goal', title: 'Beta', parent: parent.id }));
  const gamma = store.create(makeCard({ type: 'goal', title: 'Gamma', parent: parent.id }));
  store.create(makeCard({ title: 'Alpha child', parent: alpha.id }));
  store.create(makeCard({ title: 'Beta child', parent: beta.id }));
  void gamma;
  parentId = parent.id;
  expectedChildOrder = [beta.id, gamma.id, alpha.id];

  rewritePosition(tmpDir, alpha.id, 2);
  rewritePosition(tmpDir, beta.id, 0);
  rewritePosition(tmpDir, gamma.id, 1);

  authToken = 'shuffled-subtree-token';
  process.env['SAIVAGE_API_TOKEN'] = authToken;
  app = Fastify({ logger: false });
  const { default: authPlugin } = await import('../../src/server/auth.js');
  await app.register(authPlugin);
  registerCardRoutes(app, tmpDir, undefined, store);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await app.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('shuffled persisted subtree ordering', () => {
  it('returns persisted position order through store, operator cards.get, get_card, and get_tree', async () => {
    const reloaded = new CardStore(tmpDir);
    expect(reloaded.listChildren(parentId)).toEqual(expectedChildOrder);

    const response = await fetch(`${baseUrl}/api/cards/${parentId}`, { headers: { authorization: `Bearer ${authToken}` } });
    expect(response.status).toBe(200);
    const body = await response.json() as { children: Array<{ id: string }> };
    expect(body.children.map((child) => child.id)).toEqual(expectedChildOrder);

    const cardResult = await get_card({ projectRoot: tmpDir, store: reloaded, actor: 'analyst', surface: 'web-chat' }, { id: parentId });
    expect(cardResult.success).toBe(true);
    expect(((cardResult.data as { children: Array<{ id: string }> }).children).map((child) => child.id)).toEqual(expectedChildOrder);

    const treeResult = await get_tree({ projectRoot: tmpDir, store: reloaded, actor: 'analyst', surface: 'web-chat' }, { rootId: parentId });
    expect(treeResult.success).toBe(true);
    expect(((treeResult.data as { children: Array<{ id: string }> }).children).map((child) => child.id)).toEqual(expectedChildOrder);
  });
});

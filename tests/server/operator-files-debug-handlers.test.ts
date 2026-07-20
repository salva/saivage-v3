import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

import { CardService } from '../../src/cards/card-service.js';
import { filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { cardNamespace } from '../../src/persistence/layout.js';

describe('operator files and debug contract handlers', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  let cards: CardService;
  let cardServiceProvider: jest.Mock<() => CardService>;
  const authHeaders = { authorization: 'Bearer route-token' };

  beforeEach(async () => {
    projectRoot = mkdtempSync(join(tmpdir(), 'saivage-files-routes-'));
    initProjectTree(projectRoot);
    cards = new CardService(projectRoot);
    cards.create({ type: 'code', parent: 'project', title: 'Child', brief: 'Brief', status: 'backlog', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    cardServiceProvider = jest.fn(() => cards);
    fastify = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'route-token' }) }).mount(
      fastify,
      filesDebugOperatorApiContracts,
      buildFilesDebugOperatorContractHandlers({ projectRoot, cardServiceProvider }),
    );
    await fastify.ready();
  });

  afterEach(async () => {
    await fastify.close();
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('short-circuits authentication before CardService or Files work', async () => {
    const list = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards' });
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fcard.jsonl' });

    expect(list.statusCode).toBe(401);
    expect(content.statusCode).toBe(401);
    expect(cardServiceProvider).not.toHaveBeenCalled();
  });

  it('navigates from the generic metadata root through the canonical virtual card subtree', async () => {
    const request = async (path: string) => fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: authHeaders });
    const root = await request('.');
    const metadata = await request('.saivage');
    const cardsRoot = await request('.saivage/cards');
    const project = await request('.saivage/cards/project');
    const children = await request('.saivage/cards/project/children');
    const leafChildren = await request('.saivage/cards/project/children/a/children');

    for (const response of [root, metadata, cardsRoot, project, children, leafChildren]) expect(response.statusCode).toBe(200);
    expect(metadata.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: cards.read('project')!.updated_at }),
    ]));
    expect(cardsRoot.json()).toEqual({ path: '.saivage/cards', files: [expect.objectContaining({ name: 'project', path: '.saivage/cards/project' })] });
    expect(project.json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'children', path: '.saivage/cards/project/children', type: 'directory' }),
      expect.objectContaining({ name: 'card.jsonl', path: '.saivage/cards/project/card.jsonl', type: 'file' }),
    ]));
    expect(children.json().files).toEqual([expect.objectContaining({ name: 'a', path: '.saivage/cards/project/children/a' })]);
    expect(leafChildren.json()).toEqual({ path: '.saivage/cards/project/children/a/children', files: [] });
  });

  it('returns declared content and opaque reserved-path envelopes', async () => {
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fbrief.jsonl', headers: authHeaders });
    const malformedLayout = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards%2Fproject%2Fconversations', headers: authHeaders });
    const aliasSpelling = await fastify.inject({ method: 'GET', url: '/api/files?path=.%2F.saivage%2Fcards', headers: authHeaders });

    expect(content.statusCode).toBe(200);
    expect(content.json()).toEqual(expect.objectContaining({ path: '.saivage/cards/project/brief.jsonl', contentType: 'text/plain', redacted: false, modifiedAt: expect.any(String) }));
    expect(malformedLayout.statusCode).toBe(404);
    expect(malformedLayout.json()).toEqual({ error: 'Path not found', path: '.saivage/cards/project/conversations' });
    expect(aliasSpelling.statusCode).toBe(404);
    expect(aliasSpelling.json()).toEqual({ error: 'Path not found', path: './.saivage/cards' });
  });

  it('lists malformed optional stream metadata but returns 500 for its explicit strict read', async () => {
    writeFileSync(join(cardNamespace(projectRoot, 'project'), 'status.jsonl'), 'complete malformed envelope\n', 'utf8');
    const listing = await fastify.inject({ method: 'GET', url: '/api/files?path=.saivage%2Fcards%2Fproject', headers: authHeaders });
    const content = await fastify.inject({ method: 'GET', url: '/api/files/content?path=.saivage%2Fcards%2Fproject%2Fstatus.jsonl', headers: authHeaders });

    expect(listing.statusCode).toBe(200);
    expect(listing.json().files).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'status.jsonl', type: 'file' })]));
    expect(content.statusCode).toBe(500);
    expect(content.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
  });

  it('keeps project and work card aliases opaque while lexical blocked aliases retain 403 and omission', async () => {
    const cardsRoot = join(projectRoot, '.saivage', 'cards');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'saivage.json'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'work', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(projectRoot, '.saivage', 'work', '.env'), 'dir');

    const request = async (path: string) => fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: authHeaders });
    expect((await request('.saivage/card-alias')).statusCode).toBe(404);
    expect((await request('work:///card-alias')).statusCode).toBe(404);
    expect((await request('.saivage/saivage.json')).statusCode).toBe(403);
    expect((await request('work:///.env')).statusCode).toBe(403);
    expect(cardServiceProvider).not.toHaveBeenCalled();

    const metadataNames = (await request('.saivage')).json().files.map(({ name }: { name: string }) => name);
    expect(metadataNames).toContain('cards');
    expect(metadataNames).not.toContain('card-alias');
    expect(metadataNames).not.toContain('saivage.json');
    const workNames = (await request('.saivage/work')).json().files.map(({ name }: { name: string }) => name);
    expect(workNames).not.toContain('card-alias');
    expect(workNames).not.toContain('.env');
    expect(cardServiceProvider).toHaveBeenCalledTimes(1);
  });
});

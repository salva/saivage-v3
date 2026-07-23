import { afterEach, describe, expect, it, jest } from '@jest/globals';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';

import { CardService, TEST_RUNTIME_WORKFLOWS } from '../helpers/canonical-project.js';
import { filesDebugOperatorApiContracts } from '../../src/contracts/operator-api-files-debug.js';
import { cardNamespace, cardStreamFile } from '../../src/persistence/layout.js';
import { AuthPolicy } from '../../src/server/auth-policy.js';
import { ContractRuntime } from '../../src/server/contract-runtime.js';
import { createEventLog } from '../../src/observability/index.js';
import { buildFilesDebugOperatorContractHandlers } from '../../src/server/routes/operator-files-debug-handlers.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';

const authHeaders = { authorization: 'Bearer e2e-files-token' };
const mutationContext = { actor: 'analyst' as const, surface: 'runtime' as const, reason: 'canonical files e2e' };

function input(parent: string, title: string, type: 'code' | 'goal' = 'code') {
  return {
    type,
    parent,
    title,
    bootstrap_content: `${title} brief`,
    tags: [],
    priority: 0,
    urgency: 'normal' as const,
    created_by: 'analyst' as const,
    depends_on: [],
    related: [],
  };
}

type Harness = {
  root: string;
  cards: CardService;
  app: FastifyInstance;
  provider: jest.Mock<() => CardService>;
  logs: unknown[][];
};

const roots: string[] = [];
const apps: FastifyInstance[] = [];

async function harness(): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), 'saivage-card-files-e2e-'));
  roots.push(root);
  initProjectTree(root);
  const cards = new CardService(root);
  const provider = jest.fn(() => cards);
  const logs: unknown[][] = [];
  const capture = (...args: unknown[]) => { logs.push(args); };
  const logger = { level: 'trace', fatal: capture, error: capture, warn: capture, info: capture, debug: capture, trace: capture, silent: capture, child() { return this; } } as unknown as FastifyBaseLogger;
  const app = Fastify({ loggerInstance: logger });
  new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'e2e-files-token' }), eventLogger: createEventLog(root) }).mount(
    app,
    filesDebugOperatorApiContracts,
    buildFilesDebugOperatorContractHandlers({ projectRoot: root, cardServiceProvider: provider, configAuthority: createTestConfigAuthority(root), workflows: TEST_RUNTIME_WORKFLOWS }),
  );
  await app.ready();
  apps.push(app);
  return { root, cards, app, provider, logs };
}

async function list(app: FastifyInstance, path: string, authenticated = true) {
  return app.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(path)}`, headers: authenticated ? authHeaders : undefined });
}

async function content(app: FastifyInstance, path: string, authenticated = true) {
  return app.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent(path)}`, headers: authenticated ? authHeaders : undefined });
}

afterEach(async () => {
  while (apps.length > 0) await apps.pop()!.close();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('canonical card Files browsing through real routes and CardService state', () => {
  it('projects reconstructed active membership, committed order, tombstones, and no physical nonmembers', async () => {
    const { root, cards, app } = await harness();
    const first = cards.create(input('project', 'First', 'goal'));
    const second = cards.create(input('project', 'Second'));
    const leaf = cards.create(input(first.id, 'Leaf'));
    const tombstoned = cards.create(input('project', 'Deleted'));
    expect(cards.reorderChildren('project', [second.id, first.id, tombstoned.id])).toEqual({ ok: true, changed: 2 });
    cards.deleteSubtrees([tombstoned.id], () => true);

    const unlinkedRoot = join(cardNamespace(root, 'project'), 'children');
    cpSync(cardNamespace(root, first.id), join(unlinkedRoot, 'z'), { recursive: true });
    mkdirSync(join(unlinkedRoot, 'y'));
    mkdirSync(join(unlinkedRoot, 'x'));
    writeFileSync(join(unlinkedRoot, 'x', 'card.jsonl'), 'complete malformed card stream\n');

    // Reconstruct from durable streams. Files must use this service's linked projections,
    // not the physically present z/y/x namespaces above.
    const reconstructed = new CardService(root);
    const provider = jest.fn(() => reconstructed);
    const reconstructedApp = Fastify({ logger: false });
    new ContractRuntime({ authPolicy: new AuthPolicy({ apiToken: 'e2e-files-token' }), eventLogger: createEventLog(root) }).mount(
      reconstructedApp,
      filesDebugOperatorApiContracts,
      buildFilesDebugOperatorContractHandlers({ projectRoot: root, cardServiceProvider: provider, configAuthority: createTestConfigAuthority(root), workflows: TEST_RUNTIME_WORKFLOWS }),
    );
    await reconstructedApp.ready();
    apps.push(reconstructedApp);

    const metadata = await list(reconstructedApp, '.saivage');
    const cardsRoot = await list(reconstructedApp, '.saivage/cards');
    const project = await list(reconstructedApp, '.saivage/cards/project');
    const children = await list(reconstructedApp, '.saivage/cards/project/children');
    const nested = await list(reconstructedApp, '.saivage/cards/project/children/a/children');
    const emptyLeaf = await list(reconstructedApp, '.saivage/cards/project/children/a/children/a/children');

    for (const response of [metadata, cardsRoot, project, children, nested, emptyLeaf]) expect(response.statusCode).toBe(200);
    expect(metadata.json().files).toEqual(expect.arrayContaining([
      { name: 'cards', path: '.saivage/cards', type: 'directory', modifiedAt: reconstructed.read('project')!.updated_at },
    ]));
    expect(cardsRoot.json()).toEqual({
      path: '.saivage/cards',
      files: [{ name: 'project', path: '.saivage/cards/project', type: 'directory', modifiedAt: reconstructed.read('project')!.updated_at }],
    });
    expect(project.json().files.map(({ name }: { name: string }) => name)).toEqual(['children', 'card.jsonl', 'brief.jsonl']);
    expect(children.json().files.map(({ name, path }: { name: string; path: string }) => ({ name, path }))).toEqual([
      { name: 'b', path: '.saivage/cards/project/children/b' },
      { name: 'a', path: '.saivage/cards/project/children/a' },
    ]);
    expect(nested.json().files).toEqual([
      expect.objectContaining({ name: 'a', path: '.saivage/cards/project/children/a/children/a', type: 'directory' }),
    ]);
    expect(emptyLeaf.json()).toEqual({ path: '.saivage/cards/project/children/a/children/a/children', files: [] });
    expect(existsSync(join(cardNamespace(root, leaf.id), 'children'))).toBe(false);

    for (const segment of ['x', 'y', 'z']) {
      const response = await list(reconstructedApp, `.saivage/cards/project/children/${segment}`);
      expect(response.statusCode).toBe(404);
    }
    expect((await list(reconstructedApp, `.saivage/cards/project/children/${tombstoned.id.split('-').at(-1)}`)).statusCode).toBe(404);

    const brief = await content(reconstructedApp, '.saivage/cards/project/children/a/brief.jsonl');
    expect(brief.statusCode).toBe(200);
    expect(brief.json()).toEqual(expect.objectContaining({
      path: '.saivage/cards/project/children/a/brief.jsonl',
      contentType: 'text/plain',
      redacted: false,
      size: expect.any(Number),
      modifiedAt: expect.any(String),
    }));
    expect(brief.json().content).toContain('First brief');
    expect((await content(reconstructedApp, '.saivage/cards/project/children/a/status.jsonl')).statusCode).toBe(404);
    expect((await content(reconstructedApp, '.saivage/cards/project/children/a/review.jsonl')).statusCode).toBe(404);
    const cardPreview = await content(reconstructedApp, '.saivage/cards/project/card.jsonl');
    expect(cardPreview.statusCode).toBe(200);
    expect(cardPreview.json().content).toContain('"format_version":2');
    expect(cardPreview.json().content).toContain('"lifecycle":{"status":"backlog"');
    expect(provider).toHaveBeenCalled();
  });

  it('rejects complete v1 card bytes without rewriting or generic fallback', async () => {
    const test = await harness();
    const path = cardStreamFile(test.root, 'project');
    const current = readFileSync(path, 'utf8');
    const old = current.replace('"format_version":2', '"format_version":1');
    writeFileSync(path, old);
    const response = await content(test.app, '.saivage/cards/project/card.jsonl');
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(readFileSync(path, 'utf8')).toBe(old);
    expect(test.provider).toHaveBeenCalledTimes(1);
  });

  it.each([
    { field: 'status', value: '"backlog"' },
    { field: 'parent', value: 'null' },
    { field: 'depth', value: '0' },
    { field: 'allowedActions', value: '[]' },
  ] as const)('rejects complete v2 card bytes carrying removed $field without rewriting or generic fallback', async ({ field, value }) => {
    const test = await harness();
    const path = cardStreamFile(test.root, 'project');
    const current = readFileSync(path, 'utf8');
    const oldShape = current.replace('"card":{', `"card":{${JSON.stringify(field)}:${value},`);
    expect(oldShape).not.toBe(current);
    writeFileSync(path, oldShape);

    const response = await content(test.app, '.saivage/cards/project/card.jsonl');

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(readFileSync(path, 'utf8')).toBe(oldShape);
    expect(test.provider).toHaveBeenCalledTimes(1);
  });

  it('keeps root and leaf virtual children available without physical children directories', async () => {
    const empty = await harness();
    expect(existsSync(join(cardNamespace(empty.root, 'project'), 'children'))).toBe(false);
    expect((await list(empty.app, '.saivage/cards/project')).json().files[0]).toEqual(expect.objectContaining({
      name: 'children', path: '.saivage/cards/project/children', type: 'directory',
    }));
    expect((await list(empty.app, '.saivage/cards/project/children')).json()).toEqual({
      path: '.saivage/cards/project/children', files: [],
    });

    const withLeaf = await harness();
    const child = withLeaf.cards.create(input('project', 'Leaf'));
    expect(existsSync(join(cardNamespace(withLeaf.root, child.id), 'children'))).toBe(false);
    expect((await list(withLeaf.app, '.saivage/cards/project/children/a/children')).json()).toEqual({
      path: '.saivage/cards/project/children/a/children', files: [],
    });
  });

  it('distinguishes optional metadata, malformed explicit content, limits, and generic preview statuses', async () => {
    const malformed = await harness();
    writeFileSync(join(cardNamespace(malformed.root, 'project'), 'status.jsonl'), 'complete malformed optional stream\n');
    const metadata = await list(malformed.app, '.saivage/cards/project');
    expect(metadata.statusCode).toBe(200);
    expect(metadata.json().files).toEqual(expect.arrayContaining([expect.objectContaining({ name: 'status.jsonl', type: 'file' })]));
    expect((await content(malformed.app, '.saivage/cards/project/status.jsonl')).statusCode).toBe(500);

    const oversized = await harness();
    writeFileSync(join(cardNamespace(oversized.root, 'project'), 'status.jsonl'), Buffer.alloc(1_048_577, 0x61));
    expect((await content(oversized.app, '.saivage/cards/project/status.jsonl')).statusCode).toBe(413);
    expect((await content(oversized.app, '.saivage/cards/project')).statusCode).toBe(400);

    writeFileSync(join(oversized.root, 'ordinary.txt'), 'ordinary generic content');
    writeFileSync(join(oversized.root, 'binary.bin'), Buffer.from([0, 1, 2, 3]));
    expect((await list(oversized.app, '.')).json().files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'ordinary.txt', path: 'ordinary.txt', type: 'file' }),
    ]));
    expect((await content(oversized.app, 'ordinary.txt')).json()).toEqual(expect.objectContaining({ content: 'ordinary generic content', redacted: false }));
    expect((await content(oversized.app, 'binary.bin')).statusCode).toBe(415);
  });

  it('fails reached linked incomplete and malformed namespaces but never consults unlinked malformed storage', async () => {
    const incomplete = await harness();
    const incompleteChild = incomplete.cards.create(input('project', 'Incomplete'));
    unlinkSync(join(cardNamespace(incomplete.root, incompleteChild.id), 'brief.jsonl'));
    expect((await list(incomplete.app, '.saivage/cards/project/children/a')).statusCode).toBe(500);

    const malformed = await harness();
    const malformedChild = malformed.cards.create(input('project', 'Malformed'));
    writeFileSync(join(cardNamespace(malformed.root, malformedChild.id), 'card.jsonl'), 'complete malformed linked card\n');
    expect((await list(malformed.app, '.saivage/cards/project/children')).statusCode).toBe(500);

    mkdirSync(join(cardNamespace(malformed.root, 'project'), 'children', 'z'));
    writeFileSync(join(cardNamespace(malformed.root, 'project'), 'children', 'z', 'card.jsonl'), 'malformed unlinked card\n');
    expect((await list(malformed.app, '.saivage/cards/project/children/z')).statusCode).toBe(404);
  });

  it('rejects reached ancestor and final-slot symlinks, including outside-project targets', async () => {
    const ancestor = await harness();
    const child = ancestor.cards.create(input('project', 'Outside ancestor'));
    const outsideNamespace = mkdtempSync(join(tmpdir(), 'saivage-card-files-outside-'));
    roots.push(outsideNamespace);
    cpSync(cardNamespace(ancestor.root, child.id), join(outsideNamespace, 'card-a'), { recursive: true });
    rmSync(cardNamespace(ancestor.root, child.id), { recursive: true });
    symlinkSync(join(outsideNamespace, 'card-a'), cardNamespace(ancestor.root, child.id), 'dir');
    expect((await list(ancestor.app, '.saivage/cards/project/children/a')).statusCode).toBe(500);

    const finalSlot = await harness();
    const outsideFileRoot = mkdtempSync(join(tmpdir(), 'saivage-card-files-slot-'));
    roots.push(outsideFileRoot);
    const outsideBrief = join(outsideFileRoot, 'brief.jsonl');
    writeFileSync(outsideBrief, 'outside target must not be read\n');
    const briefPath = join(cardNamespace(finalSlot.root, 'project'), 'brief.jsonl');
    unlinkSync(briefPath);
    symlinkSync(outsideBrief, briefPath);
    expect((await list(finalSlot.app, '.saivage/cards/project')).statusCode).toBe(500);
    expect((await content(finalSlot.app, '.saivage/cards/project/brief.jsonl')).statusCode).toBe(500);
  });

  it('preserves authentication, traversal, project/work blocked-source precedence, and opaque aliases', async () => {
    const { root, app, provider } = await harness();
    const cardsRoot = join(root, '.saivage', 'cards');
    symlinkSync(cardsRoot, join(root, '.saivage', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(root, '.saivage', 'saivage.json'), 'dir');
    symlinkSync(cardsRoot, join(root, '.saivage', 'work', 'card-alias'), 'dir');
    symlinkSync(cardsRoot, join(root, '.saivage', 'work', '.env'), 'dir');

    expect((await list(app, '.saivage/cards', false)).statusCode).toBe(401);
    expect(provider).not.toHaveBeenCalled();
    expect((await list(app, '../.saivage/cards')).statusCode).toBe(403);
    expect((await list(app, '.saivage/saivage.json')).statusCode).toBe(403);
    expect((await content(app, '.saivage/saivage.json')).statusCode).toBe(403);
    expect((await list(app, 'work:///.env')).statusCode).toBe(403);
    expect((await content(app, 'work:///.env')).statusCode).toBe(403);
    expect((await list(app, '.saivage/card-alias')).statusCode).toBe(404);
    expect((await content(app, '.saivage/card-alias/project/card.jsonl')).statusCode).toBe(404);
    expect((await list(app, 'work:///card-alias')).statusCode).toBe(404);
    expect((await content(app, 'work:///card-alias/project/card.jsonl')).statusCode).toBe(404);
    expect((await list(app, 'work:///card-alias/')).statusCode).toBe(403);

    const metadataNames = (await list(app, '.saivage')).json().files.map(({ name }: { name: string }) => name);
    expect(metadataNames).toContain('cards');
    expect(metadataNames).not.toContain('card-alias');
    expect(metadataNames).not.toContain('saivage.json');
    const workNames = (await list(app, '.saivage/work')).json().files.map(({ name }: { name: string }) => name);
    expect(workNames).not.toContain('card-alias');
    expect(workNames).not.toContain('.env');

    const recordUrl = 'record:///brief.md?card=project&v=latest';
    expect((await content(app, recordUrl)).statusCode).toBe(200);
  });

  it('keeps record URL absence typed while strict and hostile reads reach the opaque 500 boundary', async () => {
    const { root, cards, app, provider, logs } = await harness();
    expect((await content(app, 'record:///status.md?card=project&v=latest')).json()).toEqual({ error: 'Closed record not found.', path: 'record:///status.md?card=project&v=latest' });
    expect((await content(app, 'record:///brief.md?card=card-z&v=latest')).statusCode).toBe(404);

    const open = cards.openRecord('project', 'status.md');
    expect((await content(app, `record:///status.md?card=project&v=${open.version}`)).statusCode).toBe(404);

    writeFileSync(join(cardNamespace(root, 'project'), 'status.jsonl'), 'complete malformed record stream\n');
    const malformed = await content(app, 'record:///status.md?card=project&v=latest');
    expect(malformed.statusCode).toBe(500);
    expect(malformed.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(malformed.body).not.toContain('malformed record stream');

    const hostileMarker = 'HOSTILE_RECORD_TOKEN_AND_PATH';
    const hostile = Object.assign(new Error(hostileMarker), { token: hostileMarker, path: `/secret/${hostileMarker}` });
    provider.mockImplementationOnce(() => ({
      recordReader: { record: () => { throw hostile; } },
      getCanonicalCard: cards.getCanonicalCard.bind(cards),
      getCanonicalCardChildren: cards.getCanonicalCardChildren.bind(cards),
      getCanonicalCardFilesMetadata: cards.getCanonicalCardFilesMetadata.bind(cards),
      getCanonicalCardFileContent: cards.getCanonicalCardFileContent.bind(cards),
    } as unknown as CardService));
    const failed = await content(app, 'record:///brief.md?card=project&v=latest');
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(failed.body).not.toContain(hostileMarker);
    expect(JSON.stringify(logs)).not.toContain(hostileMarker);
  });
});

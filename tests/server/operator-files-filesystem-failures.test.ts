import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';

const statFailures = new Map<string, unknown>();

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  statSync: ((...args: unknown[]) => {
    const path = resolve(String(args[0]));
    if (statFailures.has(path)) throw statFailures.get(path);
    return Reflect.apply(realFs.statSync, undefined, args);
  }) as typeof realFs.statSync,
}));

const { filesDebugOperatorApiContracts } = await import('../../src/contracts/operator-api-files-debug.js');
const { AuthPolicy } = await import('../../src/server/auth-policy.js');
const { ContractRuntime } = await import('../../src/server/contract-runtime.js');
const { buildFilesDebugOperatorContractHandlers } = await import('../../src/server/routes/operator-files-debug-handlers.js');
const { buildEventsOperatorContractHandlers } = await import('../../src/server/routes/operator-events-handlers.js');
const { createTestConfigAuthority } = await import('../helpers/project-config.js');
const { testApplicationFatalPort } = await import('../helpers/test-application-fatal-port.js');

function errno(code: string, marker: string): NodeJS.ErrnoException {
  return Object.assign(new Error(marker), { code });
}

describe('operator Files filesystem failure normalization', () => {
  let fastify: FastifyInstance;
  let projectRoot: string;
  let directory: string;
  let contentFile: string;
  let child: string;

  beforeEach(async () => {
    statFailures.clear();
    projectRoot = realFs.mkdtempSync(join(tmpdir(), 'saivage-files-failures-'));
    directory = join(projectRoot, 'directory');
    contentFile = join(projectRoot, 'content.txt');
    child = join(directory, 'child.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(contentFile, 'content');
    realFs.writeFileSync(child, 'child');

    fastify = Fastify({ logger: false });
    const handlers = buildFilesDebugOperatorContractHandlers({
      projectRoot,
      cardServiceProvider: () => { throw new Error('Canonical cards are not used by generic Files tests.'); },
      configAuthority: createTestConfigAuthority(projectRoot),
      workflows: {} as never,
    });
    new ContractRuntime({
      authPolicy: new AuthPolicy(),
      eventLogger: { appendEventPrepared: jest.fn() } as never,
      fatalPort: testApplicationFatalPort,
    }).mount(fastify, filesDebugOperatorApiContracts, { ...buildEventsOperatorContractHandlers({ projectRoot }), ...handlers });
    await fastify.ready();
  });

  afterEach(async () => {
    statFailures.clear();
    await fastify.close();
    realFs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns the exact opaque 500 for non-ENOENT requested-target failures on list and content', async () => {
    const marker = 'requested-target-private-marker';
    const cases = [
      { path: directory, url: `/api/files?path=${encodeURIComponent('directory')}` },
      { path: contentFile, url: `/api/files/content?path=${encodeURIComponent('content.txt')}` },
    ];

    for (const testCase of cases) {
      statFailures.set(resolve(testCase.path), errno('EACCES', marker));
      const response = await fastify.inject({ method: 'GET', url: testCase.url });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
      expect(response.body).not.toContain(marker);
      expect(response.body).not.toContain(projectRoot);
      statFailures.clear();
    }
  });

  it('lists encoded work children and reads the exact filename through scoped and native Files route queries', async () => {
    const directoryName = 'space # percent% unicode-é';
    const directory = join(projectRoot, '.saivage/work/cards', directoryName);
    realFs.mkdirSync(directory, { recursive: true });
    const names = ['#.txt', '%23.txt', '?.txt', '%3F.txt'];
    for (const name of names) realFs.writeFileSync(join(directory, name), `exact ${name}`);
    const scoped = `work:///cards/${encodeURIComponent(directoryName)}`;
    const listing = await fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent(scoped)}` });
    expect(listing.statusCode).toBe(200);
    const files = listing.json().files as Array<{ name: string; path: string }>;
    expect(files.map(file => file.name).sort()).toEqual([...names].sort());
    for (const file of files) {
      expect(file.path).toBe(`${scoped}/${encodeURIComponent(file.name)}`);
      for (const path of [file.path, `.saivage/work/cards/${directoryName}/${file.name}`]) {
        const response = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent(path)}` });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ content: `exact ${file.name}` });
      }
    }
    for (const suffix of ['?', '#', '?x=1', '#fragment']) {
      const response = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent(`${scoped}/%23.txt${suffix}`)}` });
      expect(response.statusCode).toBe(403);
    }
  });

  it('keeps exact requested-target ENOENT as the declared list and content 404', async () => {
    statFailures.set(resolve(directory), errno('ENOENT', 'list target disappeared'));
    const list = await fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent('directory')}` });
    statFailures.clear();
    statFailures.set(resolve(contentFile), errno('ENOENT', 'content target disappeared'));
    const content = await fastify.inject({ method: 'GET', url: `/api/files/content?path=${encodeURIComponent('content.txt')}` });

    expect(list.statusCode).toBe(404);
    expect(list.json()).toEqual({ error: 'Path not found', path: 'directory' });
    expect(content.statusCode).toBe(404);
    expect(content.json()).toEqual({ error: 'File not found', path: 'content.txt' });
  });

  it('rejects a list snapshot opaquely for a reached child non-ENOENT metadata failure', async () => {
    const marker = 'child-private-marker';
    statFailures.set(resolve(child), errno('EACCES', marker));

    const response = await fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent('directory')}` });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ error: 'InternalServerError', message: 'Internal server error' });
    expect(response.body).not.toContain(marker);
    expect(response.body).not.toContain(projectRoot);
    expect(response.body).not.toContain('child.txt');
  });

  it('returns a successful list without a reached child whose metadata stat reports exact ENOENT', async () => {
    statFailures.set(resolve(child), errno('ENOENT', 'child disappeared'));

    const response = await fastify.inject({ method: 'GET', url: `/api/files?path=${encodeURIComponent('directory')}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: 'directory', files: [] });
  });
});

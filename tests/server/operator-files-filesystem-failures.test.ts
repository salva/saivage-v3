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
    }).mount(fastify, filesDebugOperatorApiContracts, handlers);
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

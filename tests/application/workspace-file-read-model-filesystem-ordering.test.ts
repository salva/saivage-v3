import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type TracedOperation = 'existsSync' | 'lstatSync' | 'readlinkSync' | 'realpathSync' | 'statSync' | 'readdirSync' | 'readFileSync';
type Trace = { operation: TracedOperation; path: string };
const traces: Trace[] = [];
const statFailures = new Map<string, unknown>();

function traced<T extends (...args: never[]) => unknown>(operation: TracedOperation, implementation: T): T {
  return ((...args: Parameters<T>) => {
    traces.push({ operation, path: resolve(String(args[0])) });
    return Reflect.apply(implementation, undefined, args) as ReturnType<T>;
  }) as T;
}

const tracedStatSync = ((...args: unknown[]) => {
  const path = resolve(String(args[0]));
  traces.push({ operation: 'statSync', path });
  if (statFailures.has(path)) throw statFailures.get(path);
  return Reflect.apply(realFs.statSync, undefined, args);
}) as typeof realFs.statSync;

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  existsSync: traced('existsSync', realFs.existsSync),
  lstatSync: traced('lstatSync', realFs.lstatSync),
  readlinkSync: traced('readlinkSync', realFs.readlinkSync),
  realpathSync: traced('realpathSync', realFs.realpathSync),
  statSync: tracedStatSync,
  readdirSync: traced('readdirSync', realFs.readdirSync),
  readFileSync: traced('readFileSync', realFs.readFileSync),
}));

const { WorkspaceFileReadModelService } = await import('../../src/application/read-models/workspace-file-read-model.js');
const { createTestConfigAuthority } = await import('../helpers/project-config.js');

const roots: string[] = [];
const records = () => ({
  current: (_cardId: string, _filename: string) => { throw new Error('No records in workspace file tests.'); },
  historical: (_cardId: string, _filename: string, _version: number) => { throw new Error('No records in workspace file tests.'); },
  definition: (_cardId: string, _filename: string) => { throw new Error('No record definitions in workspace file tests.'); },
  definitions: (_cardId: string) => [],
  getCanonicalCard: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardChildren: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardFilesMetadata: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardFileContent: () => ({ kind: 'card-not-found' as const }),
  readCardVersion: () => ({ kind: 'card-not-found' as const }),
});

function temporaryRoot(prefix: string): string {
  const root = realFs.mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function projectionTracesFor(...paths: string[]): Trace[] {
  const resolvedPaths = new Set(paths.map((path) => resolve(path)));
  return traces.filter((trace) => resolvedPaths.has(trace.path));
}

function targetProjectionTracesFor(...paths: string[]): Trace[] {
  return projectionTracesFor(...paths).filter((trace) => ['statSync', 'readdirSync', 'readFileSync'].includes(trace.operation));
}

function listedNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return [];
  return body.files.map((file: unknown) => {
    if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string') throw new Error('Listed file is missing its name.');
    return file.name;
  });
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`synthetic ${code}`), { code });
}

function caughtValue(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected action to throw.');
}

beforeEach(() => {
  traces.length = 0;
  statFailures.clear();
});
afterEach(() => {
  while (roots.length > 0) realFs.rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('WorkspaceFileReadModelService pre-I/O admission ordering', () => {
  it('does not project or read direct blocked project and work targets', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const projectBlocked = join(root, '.env');
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    const workBlocked = join(workRoot, '.env');
    const lockRoot = join(root, '.saivage/locks');
    realFs.mkdirSync(workRoot, { recursive: true });
    realFs.mkdirSync(lockRoot, { recursive: true });
    realFs.writeFileSync(projectBlocked, 'synthetic blocked project value');
    realFs.writeFileSync(workBlocked, 'synthetic blocked work value');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('.env').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.listFiles('.saivage/locks').statusCode).toBe(403);
    expect(service.readFileContent('.saivage/locks/not-created.lock').statusCode).toBe(403);
    expect(projectionTracesFor(projectBlocked, workBlocked, lockRoot, join(lockRoot, 'not-created.lock'))).toEqual([]);
  });

  it('omits blocked project and work children before child metadata projection', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const projectBlocked = join(root, '.env');
    const projectAlias = join(root, 'safe-project-alias');
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    const workBlocked = join(workRoot, '.env');
    const workAlias = join(workRoot, 'safe-work-alias');
    realFs.mkdirSync(workRoot, { recursive: true });
    realFs.writeFileSync(projectBlocked, 'synthetic blocked project value');
    realFs.writeFileSync(workBlocked, 'synthetic blocked work value');
    realFs.symlinkSync('.env', projectAlias);
    realFs.symlinkSync('.env', workAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    const projectListing = service.listFiles('.');
    const workListing = service.listFiles('work:///processes/proc-1');
    const projectNames = listedNames(projectListing.body);
    const workNames = listedNames(workListing.body);
    expect(projectNames).not.toEqual(expect.arrayContaining(['.env', 'safe-project-alias']));
    expect(workNames).not.toEqual(expect.arrayContaining(['.env', 'safe-work-alias']));
    expect(targetProjectionTracesFor(projectBlocked, workBlocked)).toEqual([]);
    expect(targetProjectionTracesFor(projectAlias, workAlias)).toEqual([]);
    expect(projectionTracesFor(root)).toEqual(expect.arrayContaining([{ operation: 'statSync', path: resolve(root) }, { operation: 'readdirSync', path: resolve(root) }]));
    expect(projectionTracesFor(workRoot)).toEqual(expect.arrayContaining([{ operation: 'statSync', path: resolve(workRoot) }, { operation: 'readdirSync', path: resolve(workRoot) }]));
  });

  it('blocks safe aliases to blocked files and directories before target operations', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const blockedFile = join(root, '.env');
    const blockedDirectory = join(root, '.saivage/locks');
    const fileAlias = join(root, 'safe-file-alias');
    const directoryAlias = join(root, 'safe-directory-alias');
    realFs.mkdirSync(blockedDirectory, { recursive: true });
    realFs.writeFileSync(blockedFile, 'synthetic blocked value');
    realFs.symlinkSync('.env', fileAlias);
    realFs.symlinkSync('.saivage/locks', directoryAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('safe-file-alias').statusCode).toBe(403);
    expect(service.listFiles('safe-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['safe-file-alias', 'safe-directory-alias']));
    expect(targetProjectionTracesFor(blockedFile, blockedDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('gives a blocked real target precedence over a lexical redaction identity without reading', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const blockedFile = join(root, '.env');
    const redactedAlias = join(root, '.saivage/saivage.yaml');
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(blockedFile, 'synthetic blocked value');
    realFs.symlinkSync('../.env', redactedAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('.saivage/saivage.yaml').statusCode).toBe(403);
    expect(targetProjectionTracesFor(blockedFile, redactedAlias)).toEqual([]);
  });

  it('fails containment for outside-root aliases before target projection or reads', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const outside = temporaryRoot('saivage-workspace-ordering-outside-');
    const outsideFile = join(outside, 'outside.txt');
    const outsideDirectory = join(outside, 'directory');
    const fileAlias = join(root, 'outside-file-alias');
    const directoryAlias = join(root, 'outside-directory-alias');
    realFs.writeFileSync(outsideFile, 'synthetic outside value');
    realFs.mkdirSync(outsideDirectory);
    realFs.symlinkSync(outsideFile, fileAlias);
    realFs.symlinkSync(outsideDirectory, directoryAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('outside-file-alias').statusCode).toBe(403);
    expect(service.listFiles('outside-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['outside-file-alias', 'outside-directory-alias']));
    expect(targetProjectionTracesFor(outsideFile, outsideDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('blocks lexical project and work sources before classifier I/O even when they link into cards', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const cardTarget = join(root, '.saivage/cards/unlinked-malformed');
    const projectBlocked = join(root, '.env');
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    const workBlocked = join(workRoot, '.env');
    realFs.mkdirSync(cardTarget, { recursive: true });
    realFs.mkdirSync(workRoot, { recursive: true });
    realFs.writeFileSync(join(cardTarget, 'arbitrary'), 'must not be inspected');
    realFs.symlinkSync(cardTarget, projectBlocked);
    realFs.symlinkSync(cardTarget, workBlocked);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('.env').statusCode).toBe(403);
    expect(service.readFileContent('.env').statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.readFileContent('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toContain('.env');
    expect(listedNames(service.listFiles('work:///processes/proc-1').body)).not.toContain('.env');
    expect(projectionTracesFor(projectBlocked, workBlocked, cardTarget, join(cardTarget, 'arbitrary'))).toEqual([]);
  });

  it('reserves allowed project and work aliases before any card-target operation', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const cardRoot = join(root, '.saivage/cards');
    const cardTarget = join(cardRoot, 'unlinked-malformed');
    const projectAlias = join(root, 'card-alias');
    const workRoot = join(root, '.saivage/work/processes/proc-1');
    const workAlias = join(workRoot, 'card-alias');
    realFs.mkdirSync(cardTarget, { recursive: true });
    realFs.mkdirSync(workRoot, { recursive: true });
    realFs.writeFileSync(join(cardTarget, 'arbitrary'), 'must not be inspected');
    realFs.symlinkSync(cardTarget, projectAlias);
    realFs.symlinkSync(cardTarget, workAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('card-alias').statusCode).toBe(404);
    expect(service.readFileContent('card-alias').statusCode).toBe(404);
    expect(service.listFiles('work:///processes/proc-1/card-alias').statusCode).toBe(404);
    expect(service.readFileContent('work:///processes/proc-1/card-alias').statusCode).toBe(404);
    expect(listedNames(service.listFiles('.').body)).not.toContain('card-alias');
    expect(listedNames(service.listFiles('work:///processes/proc-1').body)).not.toContain('card-alias');
    expect(projectionTracesFor(projectAlias)).toEqual(expect.arrayContaining([{ operation: 'lstatSync', path: resolve(projectAlias) }, { operation: 'readlinkSync', path: resolve(projectAlias) }]));
    expect(projectionTracesFor(workAlias)).toEqual(expect.arrayContaining([{ operation: 'lstatSync', path: resolve(workAlias) }, { operation: 'readlinkSync', path: resolve(workAlias) }]));
    expect(projectionTracesFor(cardRoot, cardTarget, join(cardTarget, 'arbitrary'))).toEqual([]);
  });

  it('rejects traversal, outside paths, and malformed work URLs without classifier I/O', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('../outside').statusCode).toBe(403);
    expect(service.listFiles(join(tmpdir(), 'outside-absolute')).statusCode).toBe(403);
    expect(service.listFiles('work:///double//segment').statusCode).toBe(403);
    expect(service.listFiles('work:///segment?query=1').statusCode).toBe(403);
    expect(traces.filter((trace) => ['lstatSync', 'readlinkSync', 'realpathSync', 'existsSync', 'statSync', 'readdirSync', 'readFileSync'].includes(trace.operation))).toEqual([]);
  });

  it('follows at most forty symlink expansions before failing closed', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    for (let index = 0; index <= 40; index += 1) {
      realFs.symlinkSync(index === 40 ? 'ordinary.txt' : `link-${index + 1}`, join(root, `link-${index}`));
    }
    realFs.writeFileSync(join(root, 'ordinary.txt'), 'ordinary');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.readFileContent('link-0').statusCode).toBe(403);
    expect(traces.filter((trace) => trace.operation === 'readlinkSync')).toHaveLength(40);
    expect(projectionTracesFor(join(root, 'ordinary.txt'))).toEqual([]);
  });

  it('never sends the direct canonical card root to generic filesystem resolution', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const cards = join(root, '.saivage/cards');
    realFs.mkdirSync(join(cards, 'project'), { recursive: true });
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('.saivage/cards').statusCode).toBe(404);
    expect(service.listFiles('./.saivage/cards/').statusCode).toBe(404);
    expect(service.readFileContent('.saivage/cards/project/card.jsonl').statusCode).toBe(404);
    expect(projectionTracesFor(cards, join(cards, 'project'), join(cards, 'project/card.jsonl'))).toEqual([]);
  });

  it('reads direct and aliased redacted YAML exactly once and never returns its synthetic secret', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const yamlPath = join(root, '.saivage/saivage.yaml');
    const aliasPath = join(root, 'safe-redacted-alias');
    const syntheticSecret = 'synthetic-redaction-value';
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(yamlPath, `apiKey: ${syntheticSecret}\nname: visible-name\n`);
    realFs.symlinkSync('.saivage/saivage.yaml', aliasPath);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    const direct = service.readFileContent('.saivage/saivage.yaml');
    const alias = service.readFileContent('safe-redacted-alias');
    for (const result of [direct, alias]) {
      expect(result.body).toEqual(expect.objectContaining({ redacted: true, sensitivity: 'sensitive-redacted' }));
      if ('content' in result.body) expect(result.body.content).not.toContain(syntheticSecret);
    }
    expect(projectionTracesFor(yamlPath).filter((trace) => trace.operation === 'readFileSync')).toHaveLength(1);
    expect(projectionTracesFor(aliasPath).filter((trace) => trace.operation === 'readFileSync')).toHaveLength(1);
  });
});

describe('WorkspaceFileReadModelService generic metadata failures', () => {
  it('stats each requested target once and maps only exact ENOENT to the existing 404', () => {
    const root = temporaryRoot('saivage-workspace-metadata-');
    const directory = join(root, 'directory');
    const file = join(root, 'file.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(file, 'content');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    statFailures.set(resolve(directory), errno('ENOENT'));
    statFailures.set(resolve(file), errno('ENOENT'));

    expect(service.listFiles('directory')).toEqual({ statusCode: 404, body: { error: 'Path not found', path: 'directory' } });
    expect(service.readFileContent('file.txt')).toEqual({ statusCode: 404, body: { error: 'File not found', path: 'file.txt' } });
    expect(targetProjectionTracesFor(directory)).toEqual([{ operation: 'statSync', path: resolve(directory) }]);
    expect(targetProjectionTracesFor(file)).toEqual([{ operation: 'statSync', path: resolve(file) }]);
  });

  it('omits only a reached child whose metadata stat reports exact ENOENT', () => {
    const root = temporaryRoot('saivage-workspace-metadata-');
    const directory = join(root, 'directory');
    const disappeared = join(directory, 'disappeared.txt');
    const retained = join(directory, 'retained.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(disappeared, 'gone');
    realFs.writeFileSync(retained, 'present');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    statFailures.set(resolve(disappeared), errno('ENOENT'));

    expect(listedNames(service.listFiles('directory').body)).toEqual(['retained.txt']);
    expect(targetProjectionTracesFor(disappeared)).toEqual([{ operation: 'statSync', path: resolve(disappeared) }]);
    expect(targetProjectionTracesFor(retained)).toEqual([{ operation: 'statSync', path: resolve(retained) }]);
  });

  it('rethrows requested-target EACCES and non-errno values unchanged', () => {
    const root = temporaryRoot('saivage-workspace-metadata-');
    const directory = join(root, 'directory');
    const file = join(root, 'file.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(file, 'content');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    const denied = errno('EACCES');
    const sentinel = null;
    statFailures.set(resolve(directory), denied);
    statFailures.set(resolve(file), sentinel);

    expect(caughtValue(() => service.listFiles('directory'))).toBe(denied);
    expect(caughtValue(() => service.readFileContent('file.txt'))).toBe(sentinel);
  });

  it('rethrows reached-child EACCES and non-errno values unchanged', () => {
    const root = temporaryRoot('saivage-workspace-metadata-');
    const directory = join(root, 'directory');
    const deniedChild = join(directory, 'denied.txt');
    const sentinelChild = join(directory, 'sentinel.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(deniedChild, 'denied');
    realFs.writeFileSync(sentinelChild, 'sentinel');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    const denied = errno('EACCES');
    statFailures.set(resolve(deniedChild), denied);

    expect(caughtValue(() => service.listFiles('directory'))).toBe(denied);

    const sentinel = Symbol('non-errno-child-sentinel');
    statFailures.delete(resolve(deniedChild));
    statFailures.set(resolve(sentinelChild), sentinel);
    expect(caughtValue(() => service.listFiles('directory'))).toBe(sentinel);
  });
});

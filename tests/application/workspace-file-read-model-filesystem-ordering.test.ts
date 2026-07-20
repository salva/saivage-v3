import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type TracedOperation = 'lstatSync' | 'statSync' | 'readdirSync' | 'readFileSync';
type Trace = { operation: TracedOperation; path: string };
const traces: Trace[] = [];

function traced<T extends (...args: never[]) => unknown>(operation: TracedOperation, implementation: T): T {
  return ((...args: Parameters<T>) => {
    traces.push({ operation, path: resolve(String(args[0])) });
    return Reflect.apply(implementation, undefined, args) as ReturnType<T>;
  }) as T;
}

jest.unstable_mockModule('node:fs', () => ({
  ...realFs,
  lstatSync: traced('lstatSync', realFs.lstatSync),
  statSync: traced('statSync', realFs.statSync),
  readdirSync: traced('readdirSync', realFs.readdirSync),
  readFileSync: traced('readFileSync', realFs.readFileSync),
}));

const { WorkspaceFileReadModelService } = await import('../../src/application/read-models/workspace-file-read-model.js');

const roots: string[] = [];
const records = () => ({
  record: (_cardId: string, _filename: string, _version: number | 'latest' | 'open') => { throw new Error('No records in workspace file tests.'); },
  isActiveCardId: (_cardId: string) => true,
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

function listedNames(body: unknown): string[] {
  if (typeof body !== 'object' || body === null || !('files' in body) || !Array.isArray(body.files)) return [];
  return body.files.map((file: unknown) => {
    if (typeof file !== 'object' || file === null || !('name' in file) || typeof file.name !== 'string') throw new Error('Listed file is missing its name.');
    return file.name;
  });
}

beforeEach(() => { traces.length = 0; });
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
    const service = new WorkspaceFileReadModelService(root, records);

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
    const service = new WorkspaceFileReadModelService(root, records);

    const projectListing = service.listFiles('.');
    const workListing = service.listFiles('work:///processes/proc-1');
    const projectNames = listedNames(projectListing.body);
    const workNames = listedNames(workListing.body);
    expect(projectNames).not.toEqual(expect.arrayContaining(['.env', 'safe-project-alias']));
    expect(workNames).not.toEqual(expect.arrayContaining(['.env', 'safe-work-alias']));
    expect(projectionTracesFor(projectBlocked, projectAlias, workBlocked, workAlias)).toEqual([]);
    expect(projectionTracesFor(root)).toEqual([{ operation: 'statSync', path: resolve(root) }, { operation: 'readdirSync', path: resolve(root) }]);
    expect(projectionTracesFor(workRoot)).toEqual([{ operation: 'statSync', path: resolve(workRoot) }, { operation: 'readdirSync', path: resolve(workRoot) }]);
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
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.readFileContent('safe-file-alias').statusCode).toBe(403);
    expect(service.listFiles('safe-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['safe-file-alias', 'safe-directory-alias']));
    expect(projectionTracesFor(blockedFile, blockedDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('gives a blocked real target precedence over a lexical redaction identity without reading', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const blockedFile = join(root, '.env');
    const redactedAlias = join(root, '.saivage/saivage.yaml');
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(blockedFile, 'synthetic blocked value');
    realFs.symlinkSync('../.env', redactedAlias);
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.readFileContent('.saivage/saivage.yaml').statusCode).toBe(403);
    expect(projectionTracesFor(blockedFile, redactedAlias)).toEqual([]);
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
    const service = new WorkspaceFileReadModelService(root, records);

    expect(service.readFileContent('outside-file-alias').statusCode).toBe(403);
    expect(service.listFiles('outside-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['outside-file-alias', 'outside-directory-alias']));
    expect(projectionTracesFor(outsideFile, outsideDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('reads direct and aliased redacted YAML exactly once and never returns its synthetic secret', () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const yamlPath = join(root, '.saivage/saivage.yaml');
    const aliasPath = join(root, 'safe-redacted-alias');
    const syntheticSecret = 'synthetic-redaction-value';
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(yamlPath, `apiKey: ${syntheticSecret}\nname: visible-name\n`);
    realFs.symlinkSync('.saivage/saivage.yaml', aliasPath);
    const service = new WorkspaceFileReadModelService(root, records);

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

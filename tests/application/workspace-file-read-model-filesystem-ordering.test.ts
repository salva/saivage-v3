import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as realFs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { outboundEffectiveSaivageConfigSchema } from '../../src/schemas/index.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

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
  readRecordCurrent: (_cardId: string, _filename: string) => { throw new Error('No records in workspace file tests.'); },
  readRecordVersion: (_cardId: string, _filename: string, _version: number) => { throw new Error('No records in workspace file tests.'); },
  getCanonicalCard: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardChildren: () => ({ kind: 'card-not-found' as const }),
  getCanonicalCardFilesMetadata: () => ({ kind: 'card-not-found' as const }),
  readCardVersion: () => ({ kind: 'card-not-found' as const }),
  readCommittedCardHead:()=>({kind:'card-not-found' as const}),
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
  it('excludes diagnostic directories, content and images through project/work aliases before target inspection', async () => {
    const root = temporaryRoot('saivage-diagnostic-files-ordering-');
    const relative = '.saivage/diagnostics'; const directory = join(root, relative);
    realFs.mkdirSync(directory, { recursive: true });
    const pixels = join(directory, 'private.png'); realFs.writeFileSync(pixels, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]));
    realFs.writeFileSync(join(root, '.saivage/diagnostics-notes'), 'ordinary');
    realFs.mkdirSync(join(root, '.saivage/diagnostics-source')); realFs.writeFileSync(join(root, '.saivage/diagnostics-source/ordinary.ts'), 'export const ordinary = true;');
    const work = join(root, '.saivage/work/processes/fixture'); realFs.mkdirSync(work, { recursive: true });
    realFs.symlinkSync(directory, join(root, 'diagnostic-alias')); realFs.symlinkSync(pixels, join(root, 'diagnostic-image'));
    realFs.symlinkSync(directory, join(work, 'diagnostic-alias')); realFs.symlinkSync(pixels, join(work, 'diagnostic-image'));
    const model = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    expect(listedNames(model.listFiles('.saivage').body)).not.toContain('diagnostics');
    expect(listedNames(model.listFiles('.saivage').body)).toContain('diagnostics-notes');
    expect(listedNames(model.listFiles('.').body)).not.toContain('diagnostic-alias');
    expect(listedNames(model.listFiles('work:///processes/fixture').body)).not.toContain('diagnostic-image');
    for (const path of [relative, `${relative}/private.png`, 'diagnostic-alias', 'diagnostic-alias/private.png', 'diagnostic-image', 'work:///processes/fixture/diagnostic-alias', 'work:///processes/fixture/diagnostic-alias/private.png', 'work:///processes/fixture/diagnostic-image']) {
      traces.length = 0;
      expect(model.listFiles(path)).toMatchObject({ statusCode: 403 });
      expect(await model.readFileContent(path)).toMatchObject({ statusCode: 403 });
      expect(await model.readFileImage(path)).toMatchObject({ statusCode: 403 });
      expect(traces.filter(trace => ['statSync', 'readdirSync', 'readFileSync'].includes(trace.operation) && (trace.path === directory || trace.path.startsWith(`${directory}/`) || trace.path.includes('diagnostic-alias') || trace.path.endsWith('diagnostic-image')))).toEqual([]);
    }
    expect((await model.readFileContent('.saivage/diagnostics-notes')).statusCode).toBeUndefined();
    expect(listedNames(model.listFiles('.saivage/diagnostics-source').body)).toContain('ordinary.ts');
    expect((await model.readFileContent('.saivage/diagnostics-source/ordinary.ts')).statusCode).toBeUndefined();
  });
  it('refuses confidential image-shaped direct/alias requests before byte reads, including config and physical conversation/card dispatch', async () => {
    const root = temporaryRoot('saivage-image-private-ordering-');
    const model = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    const paths = ['.env', '.saivage/auth-profiles.json', '.saivage/saivage.yaml', '.saivage/repair-attic/pixels', '.saivage/agents/conversations/analyst/images/pixels.png', '.saivage/cards/project/conversations/planner/images/pixels.png'];
    for (const [index, path] of paths.entries()) {
      const target = join(root, path);
      realFs.mkdirSync(realFs.realpathSync(root) + '/' + path.split('/').slice(0, -1).join('/'), {recursive: true});
      realFs.writeFileSync(target, Buffer.from([137,80,78,71,13,10,26,10,0]));
      const alias = `pixel-alias-${index}`; realFs.symlinkSync(path, join(root, alias));
      for (const request of [path, alias]) {
        traces.length = 0;
        expect((await model.readFileImage(request)).statusCode).toBe(403);
        expect(traces.filter(({operation}) => operation === 'readFileSync')).toEqual([]);
      }
    }
  });
  it('omits/refuses exact repair attic and resolved aliases before listing or reading contents, allowing similarly named siblings', async () => {
    const root = temporaryRoot('saivage-attic-files-');
    const attic = join(root,'.saivage','repair-attic'); realFs.mkdirSync(attic,{recursive:true});
    const privatePath = join(attic,'corrupt.bin'); realFs.writeFileSync(privatePath,Buffer.from([0xff,0x00]));
    const ordinary = join(root,'.saivage','repair-attic-notes'); realFs.writeFileSync(ordinary,'ordinary');
    const alias=join(root,'attic-alias'); realFs.symlinkSync(attic,alias); realFs.symlinkSync(privatePath,join(root,'attic-file-alias'));
    const model = new WorkspaceFileReadModelService(root,records,createTestConfigAuthority(root));
    expect(listedNames(model.listFiles('.saivage').body)).not.toContain('repair-attic');
    expect(listedNames(model.listFiles('.saivage').body)).toContain('repair-attic-notes');
    expect(listedNames(model.listFiles('.').body)).not.toContain('attic-alias');
    expect(listedNames(model.listFiles('.').body)).not.toContain('attic-file-alias');
    for(const path of ['.saivage/repair-attic','.saivage/repair-attic/corrupt.bin','attic-alias','attic-alias/corrupt.bin','attic-file-alias']) {
      traces.length=0; expect(model.listFiles(path)).toMatchObject({statusCode:403}); expect(await model.readFileContent(path)).toMatchObject({statusCode:403});
      expect(traces.filter(({operation,path})=>['readdirSync','readFileSync'].includes(operation)&&(path===attic||path.startsWith(`${attic}/`)||path===alias||path.startsWith(`${alias}/`)||path===join(root,'attic-file-alias')))).toEqual([]);
    }
    expect((await model.readFileContent('.saivage/repair-attic-notes')).statusCode).toBeUndefined();
  });
  it('omits/refuses global previous-index slots and resolved aliases before reading bytes', async () => {
    const root = temporaryRoot('saivage-previous-index-files-');
    const relative = '.saivage/agents/conversations/analyst'; const directory = join(root, relative);
    realFs.mkdirSync(directory, {recursive:true});
    const previous = join(directory, 'index.prev.json'); realFs.writeFileSync(previous, 'not public');
    realFs.writeFileSync(join(directory, 'index.previous.json'), 'ordinary similarly named file');
    const alias = join(root, 'previous-alias'); realFs.symlinkSync(previous, alias);
    const model = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    expect(listedNames(model.listFiles(relative).body)).not.toContain('index.prev.json');
    expect(listedNames(model.listFiles(relative).body)).toContain('index.previous.json');
    for (const path of [`${relative}/index.prev.json`, 'previous-alias']) {
      traces.length = 0; expect(await model.readFileContent(path)).toMatchObject({statusCode:403});
      expect(projectionTracesFor(previous, alias).filter(({operation})=>operation==='readFileSync')).toEqual([]);
    }
  });
  it.each([null, 7])('classifies record card absence with one owning read for version %s', async (version) => {
    const root = temporaryRoot('saivage-workspace-record-absence-');
    const reader = {
      ...records(),
      readRecordCurrent: jest.fn(() => ({ kind: 'card-not-found' as const })),
      readRecordVersion: jest.fn(() => ({ kind: 'card-not-found' as const })),
      getCanonicalCard: jest.fn(() => { throw new Error('No second card lookup.'); }),
    };
    const service = new WorkspaceFileReadModelService(root, () => reader, createTestConfigAuthority(root));
    const path = `record:///status.md?card=card-b${version === null ? '' : `&v=${version}`}`;
    expect(await service.readFileContent(path)).toEqual({
      statusCode: 404,
      body: { error: 'workspace_card_not_found', path, card_id: 'card-b' },
    });
    expect(reader.readRecordCurrent).toHaveBeenCalledTimes(version === null ? 1 : 0);
    expect(reader.readRecordVersion).toHaveBeenCalledTimes(version === null ? 0 : 1);
    expect(reader.getCanonicalCard).not.toHaveBeenCalled();
    expect(traces).toEqual([]);
  });

  it('does not project or read direct blocked project and work targets', async () => {
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

    expect((await service.readFileContent('.env')).statusCode).toBe(403);
    expect((await service.readFileContent('work:///processes/proc-1/.env')).statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect(service.listFiles('.saivage/locks').statusCode).toBe(403);
    expect((await service.readFileContent('.saivage/locks/not-created.lock')).statusCode).toBe(403);
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

  it('blocks safe aliases to blocked files and directories before target operations', async () => {
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

    expect((await service.readFileContent('safe-file-alias')).statusCode).toBe(403);
    expect(service.listFiles('safe-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['safe-file-alias', 'safe-directory-alias']));
    expect(targetProjectionTracesFor(blockedFile, blockedDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('gives a blocked real target precedence over a lexical redaction identity without reading', async () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const blockedFile = join(root, '.env');
    const redactedAlias = join(root, '.saivage/saivage.yaml');
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(blockedFile, 'synthetic blocked value');
    realFs.symlinkSync('../.env', redactedAlias);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect((await service.readFileContent('.saivage/saivage.yaml')).statusCode).toBe(403);
    expect(targetProjectionTracesFor(blockedFile, redactedAlias)).toEqual([]);
  });

  it('fails containment for outside-root aliases before target projection or reads', async () => {
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

    expect((await service.readFileContent('outside-file-alias')).statusCode).toBe(403);
    expect(service.listFiles('outside-directory-alias').statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toEqual(expect.arrayContaining(['outside-file-alias', 'outside-directory-alias']));
    expect(targetProjectionTracesFor(outsideFile, outsideDirectory, fileAlias, directoryAlias)).toEqual([]);
  });

  it('blocks lexical project and work sources before classifier I/O even when they link into cards', async () => {
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
    expect((await service.readFileContent('.env')).statusCode).toBe(403);
    expect(service.listFiles('work:///processes/proc-1/.env').statusCode).toBe(403);
    expect((await service.readFileContent('work:///processes/proc-1/.env')).statusCode).toBe(403);
    expect(listedNames(service.listFiles('.').body)).not.toContain('.env');
    expect(listedNames(service.listFiles('work:///processes/proc-1').body)).not.toContain('.env');
    expect(projectionTracesFor(projectBlocked, workBlocked, cardTarget, join(cardTarget, 'arbitrary'))).toEqual([]);
  });

  it('reserves allowed project and work aliases before any card-target operation', async () => {
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
    expect((await service.readFileContent('card-alias')).statusCode).toBe(404);
    expect(service.listFiles('work:///processes/proc-1/card-alias').statusCode).toBe(404);
    expect((await service.readFileContent('work:///processes/proc-1/card-alias')).statusCode).toBe(404);
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

  it('follows at most forty symlink expansions before failing closed', async () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    for (let index = 0; index <= 40; index += 1) {
      realFs.symlinkSync(index === 40 ? 'ordinary.txt' : `link-${index + 1}`, join(root, `link-${index}`));
    }
    realFs.writeFileSync(join(root, 'ordinary.txt'), 'ordinary');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect((await service.readFileContent('link-0')).statusCode).toBe(403);
    expect(traces.filter((trace) => trace.operation === 'readlinkSync')).toHaveLength(40);
    expect(projectionTracesFor(join(root, 'ordinary.txt'))).toEqual([]);
  });

  it('never sends the direct canonical card root to generic filesystem resolution', async () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const cards = join(root, '.saivage/cards');
    realFs.mkdirSync(join(cards, 'project'), { recursive: true });
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));

    expect(service.listFiles('.saivage/cards').statusCode).toBe(404);
    expect(service.listFiles('./.saivage/cards/').statusCode).toBe(404);
    expect((await service.readFileContent('.saivage/cards/project/card.jsonl')).statusCode).toBe(404);
    expect(projectionTracesFor(cards, join(cards, 'project'), join(cards, 'project/card.jsonl'))).toEqual([]);
  });

  it('reads direct and aliased selected config through the shared safe projection', async () => {
    const root = temporaryRoot('saivage-workspace-ordering-');
    const yamlPath = join(root, '.saivage/saivage.yaml');
    const aliasPath = join(root, 'safe-redacted-alias');
    const syntheticSecret = 'synthetic-redaction-value';
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.providers.test = {
      ...config.providers.test,
      apiKey: syntheticSecret,
      baseUrl: 'https://provider-user:provider-pass@provider.example.test/v1?token=secret#private',
    };
    config.mcpServers = {
      remote: {
        transport: 'streamable-http',
        url: 'https://mcp-user:mcp-pass@mcp.example.test/rpc?token=secret#private',
        disabled: false,
        autostart: true,
      },
    };
    realFs.mkdirSync(join(root, '.saivage'), { recursive: true });
    realFs.writeFileSync(yamlPath, `apiKey: ${syntheticSecret}\nname: visible-name\n`);
    realFs.symlinkSync('.saivage/saivage.yaml', aliasPath);
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root, { relativePath: '.saivage/saivage.yaml', config }));

    const direct = await service.readFileContent('.saivage/saivage.yaml');
    const alias = await service.readFileContent('safe-redacted-alias');
    for (const result of [direct, alias]) {
      expect(result.body).toEqual(expect.objectContaining({ redacted: true, sensitivity: 'sensitive-redacted' }));
      if ('content' in result.body) {
        const projected = outboundEffectiveSaivageConfigSchema.parse(JSON.parse(result.body.content));
        expect(JSON.stringify(projected)).not.toContain(syntheticSecret);
        expect(JSON.stringify(projected)).not.toContain('baseUrl');
        expect(JSON.stringify(projected)).not.toContain('provider-user');
        expect(JSON.stringify(projected)).not.toContain('mcp-user');
      }
    }
    expect(projectionTracesFor(yamlPath).filter((trace) => trace.operation === 'readFileSync')).toHaveLength(3);
    expect(projectionTracesFor(aliasPath).filter((trace) => trace.operation === 'readFileSync')).toHaveLength(1);
  });
});

describe('WorkspaceFileReadModelService generic metadata failures', () => {
  it('stats each requested target once and maps only exact ENOENT to the existing 404', async () => {
    const root = temporaryRoot('saivage-workspace-metadata-');
    const directory = join(root, 'directory');
    const file = join(root, 'file.txt');
    realFs.mkdirSync(directory);
    realFs.writeFileSync(file, 'content');
    const service = new WorkspaceFileReadModelService(root, records, createTestConfigAuthority(root));
    statFailures.set(resolve(directory), errno('ENOENT'));
    statFailures.set(resolve(file), errno('ENOENT'));

    expect(service.listFiles('directory')).toEqual({ statusCode: 404, body: { error: 'Path not found', path: 'directory' } });
    expect(await service.readFileContent('file.txt')).toEqual({ statusCode: 404, body: { error: 'File not found', path: 'file.txt' } });
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

  it('rethrows requested-target EACCES and non-errno values unchanged', async () => {
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
    await expect(service.readFileContent('file.txt')).rejects.toBe(sentinel);
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

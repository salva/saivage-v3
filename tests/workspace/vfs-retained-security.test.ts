import { afterEach, describe, expect, it, jest } from '@jest/globals';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, parse, relative, resolve, sep } from 'node:path';

// Jest snapshots named built-in exports; forward these four calls to the
// original modules so operation-local spies observe actual filesystem use.
jest.unstable_mockModule('node:fs', () => ({
  ...fs, default: fs,
  readdirSync: (...args: Parameters<typeof fs.readdirSync>) => fs.readdirSync(...args),
  lstatSync: ((...args) => Reflect.apply(fs.lstatSync, fs, args)) as typeof fs.lstatSync,
}));
jest.unstable_mockModule('node:fs/promises', () => ({
  ...fsPromises, default: fsPromises,
  readdir: (...args: Parameters<typeof fsPromises.readdir>) => fsPromises.readdir(...args),
  lstat: (...args: Parameters<typeof fsPromises.lstat>) => fsPromises.lstat(...args),
}));

const { CardService, initProjectTree } = await import('../helpers/canonical-project.js');
const { displayPathForResolved, listScopedPath, resolveScopedPath, visitFiles, visitScopedFiles } = await import('../../src/workspace/vfs.js');
const { authorizeWriteProject, editProject, globProject, grepProject, readProject: readWithObservations, writeProject } = await import('../../src/tools/project-file-tools.js');
const { testWorkspaceAuthority } = await import('../helpers/capability-grants.js');
const readProject = async (...args: Parameters<typeof readWithObservations>) => (await readWithObservations(...args)).data;
import { buildScopedPathUrl } from '../../src/contracts/scoped-path-url.js';
const { cardNamespace, cardPublicWorkRoot, cardReposWorkRoot } = await import('../../src/persistence/layout.js');

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
function fail(message: string): Error { return new Error(message); }
function systemUrl(absolutePath: string): string {
  const normalized = resolve(absolutePath);
  return buildScopedPathUrl('system', relative(parse(normalized).root, normalized).split(sep).filter(Boolean));
}

describe('workspace VFS and project-file security', () => {
  it('keeps managed writes inside ordinary owned destinations without granting legacy aliases', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cardwork-authored-destinations-'));
    roots.push(root);
    const ctx = { projectRoot: root, cardId: 'card-a', agentName: 'executor' as const, authority: testWorkspaceAuthority('card-a') };
    const publicRoot = cardPublicWorkRoot(root, ctx.cardId);
    const repos = cardReposWorkRoot(root, ctx.cardId);
    const work = 'cardwork:///card-a';
    const file = `${work}/public/purpose/where-plan.ts`;
    await expect(writeProject(ctx, { path: file, content: 'before' })).resolves.toMatchObject({ kind: 'applied', data: { target: file } });
    await expect(writeProject(ctx, { path: `${work}/repos/absent/new.ts`, content: 'no' })).rejects.toThrow();
    expect(existsSync(repos)).toBe(false);
    mkdirSync(join(repos, 'checkout'), { recursive: true });
    const checkoutFile = `${work}/repos/checkout/src/case%253F.ts`;
    await expect(writeProject(ctx, { path: checkoutFile, content: 'ordinary' })).resolves.toMatchObject({ data: { target: checkoutFile } });
    expect(readFileSync(join(repos, 'checkout/src/case%3F.ts'), 'utf8')).toBe('ordinary');
    writeFileSync(join(repos, 'not-a-checkout.ts'), 'ordinary bytes but not a checkout');
    await expect(readProject(ctx, { path: `${work}/repos/not-a-checkout.ts` })).rejects.toThrow();
    await expect(readProject(ctx, { path: `${work}/repos` })).resolves.toMatchObject({ entries: { items: [{ name: 'checkout', type: 'dir' }] } });
    await expect(globProject(ctx, { directory: `${work}/repos`, pattern: '**/*.ts' })).resolves.toMatchObject({ matches: { items: [checkoutFile] } });
    writeFileSync(join(repos, 'checkout/.git'), 'gitdir: git-internal');
    mkdirSync(join(publicRoot, '.git'));
    mkdirSync(join(publicRoot, '.saivage'));
    writeFileSync(join(publicRoot, '.env'), 'fixture');
    await expect(writeProject(ctx, { path: `${work}/public/.gitignore`, content: 'ordinary' })).resolves.toMatchObject({ kind: 'applied' });
    symlinkSync(join(publicRoot, 'purpose'), join(publicRoot, 'linked'));
    symlinkSync(join(publicRoot, 'purpose/where-plan.ts'), join(publicRoot, 'leaf.ts'));
    symlinkSync('public', join(publicRoot, '..', 'shell'));
    symlinkSync(publicRoot, join(root, 'alias'));
    symlinkSync(publicRoot, join(publicRoot, '..', 'tmp'));
    for (const path of [work, `${work}/public`, `${work}/repos`, `${work}/repos/checkout`,
      `${work}/public/.git/new.ts`, `${work}/repos/checkout/.git`,
      `${work}/public/.env`, `${work}/public/.saivage/file.ts`, `${work}/public/purpose`,
      `${work}/public/leaf.ts`, `${work}/public/linked/new-parent/new.ts`,
      '.saivage/work/cards/card-a/shell/purpose/where-plan.ts',
      'project:///.saivage/work/cards/card-a/public/purpose/where-plan.ts',
      'work:///cards/card-a/public/purpose/where-plan.ts',
      'tmp:///card-a/new-parent/new.ts', systemUrl(join(root, 'alias/new-parent/new.ts')),
      'alias/new-parent/new.ts', 'project:///alias/new-parent/new.ts']) {
      await expect(writeProject(ctx, { path, content: 'no' })).rejects.toThrow();
    }
    expect(existsSync(join(publicRoot, 'new-parent'))).toBe(false);
    expect(existsSync(join(publicRoot, 'purpose/new-parent'))).toBe(false);
    expect(readFileSync(join(publicRoot, 'purpose/where-plan.ts'), 'utf8')).toBe('before');
    expect(readFileSync(join(publicRoot, '../shell/purpose/where-plan.ts'), 'utf8')).toBe('before');
    for (const path of [`${work}/public/leaf.ts`, `${work}/public/linked/where-plan.ts`,
      `${work}/public/.env`, `${work}/public/.git`, `${work}/repos/checkout/.git`])
      await expect(readProject(ctx, { path })).rejects.toThrow();
    await expect(readProject(ctx, { path: 'work:///cards/card-a/shell/purpose/where-plan.ts' })).resolves.toMatchObject({ content: { content: 'before' } });
    await expect(globProject(ctx, { directory: `${work}/public`, pattern: '**/*.ts' })).resolves.toMatchObject({ matches: { items: [file] } });
  });

  it.each([true, false])('lists and visits exact native cardwork names (genuine replacement character: %s)', async (genuine) => {
    const root = mkdtempSync(join(tmpdir(), 'cardwork-native-bytes-'));
    roots.push(root);
    const base = cardPublicWorkRoot(root, 'card-a');
    const locator = 'cardwork:///card-a/public';
    const ctx = { projectRoot: root, cardId: 'card-a', agentName: 'executor' as const, authority: testWorkspaceAuthority('card-a') };
    mkdirSync(join(base, 'a'), { recursive: true });
    mkdirSync(join(base, 'bad\\dir'));
    const invalid = Buffer.concat([Buffer.from(`${base}/a`), Buffer.from([0xff]), Buffer.from('.ts')]);
    writeFileSync(invalid, 'needle invalid bytes');
    writeFileSync(join(base, 'a\\b.ts'), 'needle not the nested file');
    writeFileSync(join(base, 'bad\\dir', 'inside.ts'), 'needle not a visited subtree');
    writeFileSync(join(base, 'a/b.ts'), 'needle nested');
    writeFileSync(join(base, 'neighbor.ts'), 'needle ordinary');
    if (genuine) writeFileSync(join(base, 'a�.ts'), 'needle genuine');

    async function checkListing(failMetadata = false) {
      const readdir = jest.spyOn(fs, 'readdirSync');
      const realLstat = fs.lstatSync;
      const lstat = jest.spyOn(fs, 'lstatSync');
      if (failMetadata) lstat.mockImplementation(((p, ...args) => {
        if (p === join(base, 'neighbor.ts')) throw Object.assign(new Error('listing metadata denied'), { code: 'EACCES' });
        return Reflect.apply(realLstat, fs, [p, ...args]);
      }) as typeof realLstat);
      try {
        const pending = readProject(ctx, { path: locator });
        if (failMetadata) await expect(pending).rejects.toThrow('listing metadata denied');
        else await expect(pending).resolves.toMatchObject({ entries: { items: [
          { name: 'a', type: 'dir' },
          ...(genuine ? [{ name: 'a�.ts', type: 'file' }] : []),
          { name: 'neighbor.ts', type: 'file' },
        ] } });
        expect(readdir.mock.calls).toEqual([[base, { encoding: 'buffer' }]]);
        const paths = lstat.mock.calls.map(([p]) => p);
        expect(paths).not.toContainEqual(invalid);
        for (const name of ['a\\b.ts', 'bad\\dir', ...(!genuine ? ['a�.ts'] : [])])
          expect(paths).not.toContain(join(base, name));
        const neighbor = paths.indexOf(join(base, 'neighbor.ts'));
        expect(neighbor).toBeGreaterThanOrEqual(0);
        expect(lstat.mock.invocationCallOrder[neighbor]).toBeGreaterThan(readdir.mock.invocationCallOrder[0]!);
      } finally {
        readdir.mockRestore();
        lstat.mockRestore();
      }
    }

    async function checkTraversal(failMetadata = false) {
      const readdir = jest.spyOn(fsPromises, 'readdir');
      const realLstat = fsPromises.lstat;
      const lstat = jest.spyOn(fsPromises, 'lstat');
      if (failMetadata) lstat.mockImplementation((async (p, ...args) => {
        if (p === join(base, 'neighbor.ts')) throw Object.assign(new Error('traversal metadata denied'), { code: 'EACCES' });
        return Reflect.apply(realLstat, fsPromises, [p, ...args]);
      }) as typeof realLstat);
      try {
        const pending = globProject(ctx, { directory: locator, pattern: '**/*.ts' });
        if (failMetadata) await expect(pending).rejects.toThrow('traversal metadata denied');
        else await expect(pending).resolves.toMatchObject({ matches: { items: [
          `${locator}/a/b.ts`,
          ...(genuine ? [`${locator}/a%EF%BF%BD.ts`] : []),
          `${locator}/neighbor.ts`,
        ] } });
        expect(readdir.mock.calls).toEqual([[base, { encoding: 'buffer' }], [join(base, 'a'), { encoding: 'buffer' }]]);
        const paths = lstat.mock.calls.map(([p]) => p);
        expect(paths).not.toContainEqual(invalid);
        for (const name of ['a\\b.ts', 'bad\\dir', ...(!genuine ? ['a�.ts'] : [])])
          expect(paths).not.toContain(join(base, name));
        for (const [path, dirIndex] of [[join(base, 'neighbor.ts'), 0], [join(base, 'a/b.ts'), 1]] as const) {
          const index = paths.indexOf(path);
          expect(index).toBeGreaterThanOrEqual(0);
          expect(lstat.mock.invocationCallOrder[index]).toBeGreaterThan(readdir.mock.invocationCallOrder[dirIndex]!);
        }
      } finally {
        readdir.mockRestore();
        lstat.mockRestore();
      }
    }

    await checkListing();
    await checkTraversal();
    if (!genuine) {
      await checkListing(true);
      await checkTraversal(true);
    }
    const nested = `${locator}/a/b.ts`;
    await expect(grepProject(ctx, { path: locator, pattern: 'needle' })).resolves.toMatchObject({
      matches: { items: [
        { path: nested, preview: 'needle nested' },
        ...(genuine ? [{ path: `${locator}/a%EF%BF%BD.ts`, preview: 'needle genuine' }] : []),
        { path: `${locator}/neighbor.ts`, preview: 'needle ordinary' },
      ] },
    });
    if (genuine) await expect(readProject(ctx, { path: `${locator}/a%EF%BF%BD.ts` })).resolves.toMatchObject({ content: { content: 'needle genuine' } });
    await expect(editProject(ctx, { path: nested, old_string: 'needle', new_string: 'updated' })).resolves.toMatchObject({ kind: 'applied', data: { path: nested, replacements: 1 } });
    expect(readFileSync(join(base, 'a/b.ts'), 'utf8')).toBe('updated nested');
    expect(readFileSync(join(base, 'a\\b.ts'), 'utf8')).toBe('needle not the nested file');
  });

  it('visits filesystem scopes depth-first by explicit string order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-order-'));
    roots.push(root);
    initProjectTree(root);
    const ordinary = join(root, 'ordered');
    mkdirSync(join(ordinary, 'b-dir'), { recursive: true });
    mkdirSync(join(ordinary, 'A-dir'), { recursive: true });
    writeFileSync(join(ordinary, 'z.txt'), 'z');
    writeFileSync(join(ordinary, 'b-dir', 'b.txt'), 'b');
    writeFileSync(join(ordinary, 'A-dir', 'a.txt'), 'a');

    const direct: string[] = [];
    await visitFiles(root, ordinary, async (_absolutePath, displayPath) => { direct.push(displayPath); });
    expect(direct).toEqual(['ordered/A-dir/a.txt', 'ordered/b-dir/b.txt', 'ordered/z.txt']);

    const fixtures = [
      ['project:///ordered', ['ordered/A-dir/a.txt', 'ordered/b-dir/b.txt', 'ordered/z.txt']],
      ['tmp:///card-a/ordered', ['.saivage/work/cards/card-a/tmp/ordered/A-dir/a.txt', '.saivage/work/cards/card-a/tmp/ordered/b-dir/b.txt', '.saivage/work/cards/card-a/tmp/ordered/z.txt']],
      ['work:///tmp/ordered', ['work:///tmp/ordered/A-dir/a.txt', 'work:///tmp/ordered/b-dir/b.txt', 'work:///tmp/ordered/z.txt']],
    ] as const;
    for (const [url] of fixtures.slice(1)) {
      const destination = url.startsWith('tmp:///')
        ? join(root, '.saivage/work/cards/card-a/tmp/ordered')
        : join(root, '.saivage/work/tmp/ordered');
      mkdirSync(join(destination, 'b-dir'), { recursive: true });
      mkdirSync(join(destination, 'A-dir'), { recursive: true });
      writeFileSync(join(destination, 'z.txt'), 'z');
      writeFileSync(join(destination, 'b-dir', 'b.txt'), 'b');
      writeFileSync(join(destination, 'A-dir', 'a.txt'), 'a');
    }
    for (const [url, expected] of fixtures) {
      const visited: string[] = [];
      await visitScopedFiles({ projectRoot: root, agent: { cardId: 'card-a', agentName: 'executor' }, fail }, url, async ({ displayPath }) => { visited.push(displayPath); });
      expect(visited).toEqual(expected);
    }

    const systemVisited: string[] = [];
    await visitScopedFiles({ projectRoot: root, fail }, systemUrl(ordinary), async ({ displayPath }) => { systemVisited.push(displayPath); });
    expect(systemVisited).toEqual([
      systemUrl(join(ordinary, 'A-dir', 'a.txt')),
      systemUrl(join(ordinary, 'b-dir', 'b.txt')),
      systemUrl(join(ordinary, 'z.txt')),
    ]);
  });

  it('visits only effective declared records in explicit filename order', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-record-order-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const child = cards.create({ type: 'goal', parent: 'project', title: 'Record order', bootstrap_content: 'brief', created_by: 'analyst', depends_on: [] });
    cards.openRecord(child.id, 'status.md');
    cards.editRecord(child.id, 'status.md', 'status');
    cards.openRecord(child.id, 'review.md');
    cards.editRecord(child.id, 'review.md', 'review');
    writeFileSync(join(cardNamespace(root, child.id), 'record-undiscoverable-orphan.jsonl'), 'needle orphan');

    const visited: string[] = [];
    await visitScopedFiles({ projectRoot: root, records: cards, fail }, `record:///${child.id}`, async ({ displayPath }) => { visited.push(displayPath); });
    expect(visited).toEqual(['brief.md', 'review.md', 'status.md'].map((name) => `record:///${name}?card=${encodeURIComponent(child.id)}`));
    expect(visited.join('\n')).not.toContain('undiscoverable-orphan');
  });

  it('filters internal, dependency, and secret paths from listing, globbing, and visiting', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    mkdirSync(join(root, 'docs'), { recursive: true });
    mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(root, 'docs', 'SPEC.md'), 'visible');
    writeFileSync(join(root, '.env'), 'SECRET=hidden');
    writeFileSync(join(root, 'node_modules', 'pkg', 'hidden.md'), 'hidden');
    const visited: string[] = [];
    await visitScopedFiles({ projectRoot: root, fail }, 'project:///', async ({ displayPath }) => { visited.push(displayPath); });
    expect(await listScopedPath({ projectRoot: root, fail }, 'project:///')).toEqual({ kind: 'entries', entries: [{ name: 'docs', type: 'dir' }] });
    expect(visited).toEqual(['docs/SPEC.md']);
  });

  it('rejects traversal, internal-state writes, secret reads, and symlink writes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    writeFileSync(join(root, '.env'), 'SECRET=hidden');
    writeFileSync(join(root, 'target.txt'), 'safe');
    symlinkSync(join(root, 'target.txt'), join(root, 'link.txt'));
    await expect(readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: '../outside' })).rejects.toThrow(/inside the project root|escapes|traversal/);
    await expect(readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: '.env' })).rejects.toThrow(/blocked for security/);
    await expect(writeProject({ authority: testWorkspaceAuthority(), projectRoot: root, agentName: 'executor' }, { path: '.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ authority: testWorkspaceAuthority(), projectRoot: root, agentName: 'executor' }, { path: 'project:///.saivage/state.json', content: 'x' })).rejects.toThrow(/internal state/);
    await expect(writeProject({ authority: testWorkspaceAuthority(), projectRoot: root, agentName: 'executor' }, { path: 'link.txt', content: 'x' })).rejects.toThrow(/symlink/);
  });

  it('classifies protected scoped writes by destination while retaining only tmp capability', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    const ctx = { authority: testWorkspaceAuthority('card-a'), projectRoot: root, agentName: 'executor' as const, cardId: 'card-a' };
    const internalRoot = resolve(root, '.saivage');
    const internalFile = resolve(internalRoot, 'state.json');
    writeFileSync(internalFile, 'retained-state');

    await expect(writeProject(ctx, { path: systemUrl(internalRoot), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(writeProject(ctx, { path: systemUrl(internalFile), content: 'replacement' })).rejects.toThrow(/internal state/);
    await expect(editProject(ctx, { path: systemUrl(internalFile), old_string: 'retained', new_string: 'replaced' })).rejects.toThrow(/internal state/);
    expect(readFileSync(internalFile, 'utf8')).toBe('retained-state');
    expect(() => authorizeWriteProject(ctx, { path: systemUrl(internalFile) })).toThrow(/internal state/);

    const siblingFile = resolve(root, '.saivage-other', 'file.txt');
    await expect(writeProject(ctx, { path: systemUrl(siblingFile), content: 'sibling-content' })).resolves.toMatchObject({ kind: 'applied', data: { destination_kind: 'system_url', target: systemUrl(siblingFile), written: true } });
    expect(readFileSync(siblingFile, 'utf8')).toBe('sibling-content');

    const tmpFile = resolve(root, '.saivage', 'work', 'cards', 'card-a', 'tmp', 'scratch.txt');
    await expect(writeProject(ctx, { path: 'tmp:///card-a/scratch.txt', content: 'tmp-content' })).resolves.toMatchObject({ kind: 'applied', data: { destination_kind: 'tmp_url', target: 'tmp:///card-a/scratch.txt', written: true } });
    expect(readFileSync(tmpFile, 'utf8')).toBe('tmp-content');
    await expect(writeProject(ctx, { path: systemUrl(tmpFile), content: 'replacement' })).rejects.toThrow(/internal state/);
    expect(readFileSync(tmpFile, 'utf8')).toBe('tmp-content');
  });

  it('redacts outbound work-file content while preserving ordinary project source text', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-security-'));
    roots.push(root);
    initProjectTree(root);
    mkdirSync(join(root, '.saivage', 'work', 'processes'), { recursive: true });
    const secret = 'ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    writeFileSync(join(root, '.saivage', 'work', 'processes', 'run.log'), `token=${secret}`);
    writeFileSync(join(root, 'example.txt'), `documentation=${secret}`);
    const work = await readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: 'work:///processes/run.log' }) as { content: { content: string } };
    const project = await readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: 'example.txt' }) as { content: { content: string } };
    expect(work.content.content).not.toContain(secret);
    expect(work.content.content).toContain('[REDACTED]');
    expect(project.content.content).toContain(secret);
  });

  it('returns the canonical work root for directory and metadata reads', async () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-vfs-work-root-'));
    roots.push(root);
    initProjectTree(root);
    const resolved = resolveScopedPath({ projectRoot: root, fail }, 'work:///', 'read');
    expect(resolved).toMatchObject({ kind: 'work', isRoot: true });
    expect(displayPathForResolved(root, resolved!)).toBe('work:///');
    await expect(listScopedPath({ projectRoot: root, fail }, 'work:///')).resolves.toMatchObject({ kind: 'entries' });
    await expect(readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: 'work:///' })).resolves.toMatchObject({ path: 'work:///', is_directory: true });
    await expect(readProject({ authority: testWorkspaceAuthority(), projectRoot: root }, { path: 'work:///', metadata_only: true })).resolves.toMatchObject({
      path: { content: 'work:///', offset_bytes: 0, next_offset_bytes: 8, utf8_bytes: 8 },
      metadata_only: true,
      is_directory: true,
    });
  });
});

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fs = await import('node:fs');
const realpathSync = jest.fn(fs.realpathSync);
const openSync = jest.fn(fs.openSync);
const readFileSync = jest.fn(fs.readFileSync);
jest.unstable_mockModule('node:fs', () => ({ ...fs, realpathSync, openSync, readFileSync }));
const { readProject, globProject, grepProject } = await import('../../src/tools/project-file-tools.js');
const { buildScopedPathUrl } = await import('../../src/contracts/scoped-path-url.js');
const systemUrl = (path: string) => buildScopedPathUrl('system', path.split('/').filter(Boolean));
const roots: string[] = [];
afterEach(() => {
  realpathSync.mockImplementation(fs.realpathSync).mockClear();
  openSync.mockClear();
  readFileSync.mockClear();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const parent = fs.mkdtempSync(join(tmpdir(), 'agent-read-privacy-'));
  roots.push(parent);
  const projectRoot = join(parent, 'project');
  const sibling = join(parent, 'sibling');
  fs.mkdirSync(projectRoot);
  fs.mkdirSync(sibling);
  return { projectRoot, sibling };
}

describe('agent filesystem confidentiality before content access', () => {
  it('refuses lexical and resolved secrets/private namespaces equally for native and system paths', async () => {
    const { projectRoot, sibling } = fixture();
    const cases = ['.env', 'credentials', 'id_ed25519', '.ssh/config', '.git/objects/secret', '.saivage/diagnostics/error.txt', '.saivage/config/mcp-servers.json', '.saivage/locks/runtime', '.saivage/repair-attic/data', '.saivage/cards/project/card-head.prev.json', '.saivage/agents/conversations/index.json'];
    const sentinel = 'synthetic-private-source-not-for-outbound';
    for (const [index, name] of cases.entries()) {
      for (const root of [projectRoot, sibling]) {
        const target = join(root, name);
        fs.mkdirSync(join(target, '..'), { recursive: true });
        fs.writeFileSync(target, sentinel);
        const alias = join(root, `alias-${index}`);
        fs.symlinkSync(target, alias);
        for (const path of [target, alias, systemUrl(target), systemUrl(alias)]) {
          openSync.mockClear();
          readFileSync.mockClear();
          await expect(readProject({ projectRoot }, { path })).rejects.toThrow(/blocked for security/);
          await expect(globProject({ projectRoot }, { directory: path, pattern: '*' })).rejects.toThrow(/blocked for security/);
          await expect(grepProject({ projectRoot }, { path, pattern: '.' })).rejects.toThrow(/blocked for security/);
          expect(openSync).not.toHaveBeenCalled();
          expect(readFileSync).not.toHaveBeenCalled();
        }
      }
    }
    // Restriction names are components/predicates, not broad substring bans.
    fs.mkdirSync(join(sibling, '.saivage-other'));
    const safe = join(sibling, '.saivage-other', 'credentials-not-secret.txt');
    fs.writeFileSync(safe, 'ordinary');
    await expect(readProject({ projectRoot }, { path: safe })).resolves.toMatchObject({ data: { content: { content: 'ordinary' } } });
  });

  it('filters aliases from directory entries before content reads and never follows encountered directory symlinks', async () => {
    const { projectRoot, sibling } = fixture();
    fs.mkdirSync(join(sibling, '.saivage'));
    fs.writeFileSync(join(sibling, '.env'), 'synthetic private sentinel');
    fs.writeFileSync(join(sibling, 'safe.txt'), 'needle safe');
    fs.symlinkSync(join(sibling, '.env'), join(sibling, 'alias-file'));
    fs.symlinkSync(join(sibling, '.saivage'), join(sibling, 'alias-directory'));
    for (const path of [sibling, systemUrl(sibling)]) {
      await expect(readProject({ projectRoot }, { path })).resolves.toMatchObject({ data: { total_entries: 1, entries: { items: [{ name: 'safe.txt', type: 'file' }] } } });
      const result = await grepProject({ projectRoot }, { path, pattern: '.' });
      expect(JSON.stringify(result)).not.toContain('synthetic private sentinel');
      expect(result).toMatchObject({ matches: { total: 1 } });
    }
    const harmless = join(sibling, 'harmless.txt');
    fs.writeFileSync(harmless, 'ordinary');
    const lexicalSecret = join(sibling, '.env.alias');
    fs.symlinkSync(harmless, lexicalSecret);
    realpathSync.mockClear();
    await expect(readProject({ projectRoot }, { path: lexicalSecret })).rejects.toThrow(/blocked for security/);
    expect(realpathSync).not.toHaveBeenCalled();
  });

  (process.getuid!() === 0 ? it.skip : it)('propagates real OS denial from an isolated unreadable directory for native and system paths', async () => {
    const { projectRoot, sibling } = fixture();
    const deniedDirectory = join(sibling, 'denied');
    fs.mkdirSync(deniedDirectory);
    const deniedFile = join(deniedDirectory, 'ordinary.txt');
    fs.writeFileSync(deniedFile, 'synthetic fixture content');
    const originalPermissions = fs.statSync(deniedDirectory).mode & 0o777;
    // Fixture-only permission setup; production reads never modify permissions.
    fs.chmodSync(deniedDirectory, 0);
    try {
      for (const target of [deniedDirectory, deniedFile]) {
        for (const path of [target, systemUrl(target)]) {
          await expect(readProject({ projectRoot }, { path })).rejects.toMatchObject({ code: 'EACCES' });
          await expect(globProject({ projectRoot }, { directory: path, pattern: '*' })).rejects.toMatchObject({ code: 'EACCES' });
          await expect(grepProject({ projectRoot }, { path, pattern: '.' })).rejects.toMatchObject({ code: 'EACCES' });
        }
      }
    } finally {
      fs.chmodSync(deniedDirectory, originalPermissions);
    }
  });

  it('propagates injected OS permission denial, including when the runner is root', async () => {
    const { projectRoot, sibling } = fixture();
    const denied = join(sibling, 'denied.txt');
    fs.writeFileSync(denied, 'unread');
    realpathSync.mockImplementation(((path: Parameters<typeof fs.realpathSync>[0]) => {
      if (String(path) === denied) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
      return fs.realpathSync(path);
    }) as typeof fs.realpathSync);
    for (const path of [denied, systemUrl(denied)]) {
      await expect(readProject({ projectRoot }, { path })).rejects.toMatchObject({ code: 'EACCES' });
      await expect(globProject({ projectRoot }, { directory: path, pattern: '*' })).rejects.toMatchObject({ code: 'EACCES' });
      await expect(grepProject({ projectRoot }, { path, pattern: '.' })).rejects.toMatchObject({ code: 'EACCES' });
    }
    expect(openSync).not.toHaveBeenCalled();
  });
});

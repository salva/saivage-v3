import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SCRIPT = join(process.cwd(), 'scripts/check-vitepress-dist-policy.js');
const DIST = 'docs/.vitepress/dist';
let root;

function git(args) {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 5000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.status).toBe(0);
  return result.stdout;
}

function runPolicy() {
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: root, encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  return result;
}

describe('VitePress dist artifact policy', () => {
  beforeEach(() => {
    const tmpRoot = resolve(process.cwd(), '../tmp');
    mkdirSync(tmpRoot, { recursive: true });
    root = mkdtempSync(join(tmpRoot, 'saivage-vitepress-policy-'));
    git(['init', '--template=', '-q']);
    mkdirSync(join(root, DIST), { recursive: true });
    writeFileSync(join(root, DIST, 'index.html'), '<h1>Generated docs</h1>\n');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('accepts ignored untracked output despite a staged ignore policy', () => {
    writeFileSync(join(root, '.gitignore'), `/${DIST}/\n`);
    git(['add', '.gitignore']);
    expect(git(['status', '--porcelain', '--', '.gitignore'])).toContain('A  .gitignore');
    expect(git(['ls-files', DIST])).toBe('');
    expect(git(['status', '--porcelain', '--', DIST])).toBe('');

    const result = runPolicy();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('VitePress dist artifact policy enforced:');
    expect(result.stderr).toBe('');
  }, 30000);

  it('rejects both tracked and dirty output despite a staged ignore policy', () => {
    writeFileSync(join(root, '.gitignore'), `/${DIST}/\n`);
    git(['add', '.gitignore']);
    git(['add', '-f', `${DIST}/index.html`]);
    expect(git(['status', '--porcelain', '--', '.gitignore'])).toContain('A  .gitignore');
    expect(git(['ls-files', DIST])).toContain(`${DIST}/index.html`);
    expect(git(['status', '--porcelain', '--', DIST])).toContain(`A  ${DIST}/index.html`);

    const result = runPolicy();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`${DIST}/ must not contain tracked files`);
    expect(result.stderr).toContain(`${DIST}/ must not leave git-visible dirty entries`);
  }, 30000);

  it('rejects missing explicit policy and untracked dirty output', () => {
    writeFileSync(join(root, '.gitignore'), '# No generated-output policy\n');
    expect(git(['ls-files', DIST])).toBe('');
    expect(git(['status', '--porcelain', '--', DIST])).toContain('?? ');

    const result = runPolicy();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`.gitignore must explicitly ignore ${DIST}/`);
    expect(result.stderr).toContain(`${DIST}/ must not leave git-visible dirty entries`);
    expect(result.stderr).not.toContain(`${DIST}/ must not contain tracked files`);
  }, 30000);
});

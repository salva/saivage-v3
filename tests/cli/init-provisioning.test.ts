import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const cli = resolve('src/cli.ts');
const loader = createRequire(import.meta.url).resolve('tsx');
jest.setTimeout(120000);
function init(root: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', loader, cli, 'init', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30000,
  });
}
const values = ['--git-delivery-branch', 'main', '--git-private-ref-namespace', 'refs/saivage/example',
  '--git-source-roots', '["."]', '--git-excluded-paths', '[".git",".saivage"]'];

describe('init provisioning before-effects admission', () => {
  it('materializes the real native bundle, commissions without precreated refs and does not replay retained init', () => {
    const root = mkdtempSync(join(tmpdir(), 'init-native-public-'));
    const env = {...process.env, GIT_AUTHOR_NAME:'Fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid',
      GIT_COMMITTER_NAME:'Fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid'};
    const git = (...args:string[]) => {
      const result = spawnSync('git', args, {cwd:root,env,encoding:'utf8',timeout:10000});
      if (result.status !== 0) throw new Error(`Fixture Git ${args[0]} failed: ${result.stderr}`);
      return result.stdout.trim();
    };
    git('init','-b','main');
    writeFileSync(join(root,'.gitignore'),'.saivage/\n');
    writeFileSync(join(root,'source.txt'),'Original delivery source.\n');
    git('add','--all'); git('commit','-m','Initial fixture source');
    const beforeTip = git('rev-parse','HEAD');
    const result = init(root, ['--profile','classic-git',...values]);
    if (result.status !== 0) throw new Error(result.stderr);
    expect(git('branch','--show-current')).toBe('main');
    expect(git('rev-parse','HEAD')).toBe(beforeTip);
    expect(git('status','--porcelain')).toBe('');
    const paths = ['saivage.yaml','config/template.json','cards/project/card-head.json','cards/project/records/executions.jsonl']
      .map(path => join(root,'.saivage',path));
    const before = paths.map(path => readFileSync(path));
    expect(before[1]!.toString()).toContain('classic-git');
    expect(before[3]!.toString()).toContain('"origin":"bootstrap"');
    expect(before[3]!.toString()).toContain('"commissioned"');
    const retained = init(root, ['--profile','classic-git',...values]);
    if (retained.status !== 0) throw new Error(retained.stderr);
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    const mismatched = [...values]; mismatched[1] = 'other-delivery';
    expect(init(root,mismatched).stderr).toContain('conflicts with the existing source policy');
    expect(paths.map(path => readFileSync(path))).toEqual(before);
  });
  it('preserves existing selection without default reselection and refuses explicit profile conflicts', () => {
    const root = mkdtempSync(join(tmpdir(), 'init-profile-'));
    expect(init(root, ['--profile', 'classic-typed']).status).toBe(0);
    const configPath = join(root, '.saivage/saivage.yaml');
    const metadata = join(root, '.saivage/config/template.json');
    const head = join(root, '.saivage/cards/project/card-head.json');
    const before = [configPath, metadata, head].map(path => readFileSync(path));
    expect(init(root).status).toBe(0);
    expect([configPath, metadata, head].map(path => readFileSync(path))).toEqual(before);
    const conflict = init(root, ['--profile', 'classic']);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('conflicts with the existing template selection');
    expect([configPath, metadata, head].map(path => readFileSync(path))).toEqual(before);
    const native = init(root, values);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain('existing OFF configuration');
    expect([configPath, metadata, head].map(path => readFileSync(path))).toEqual(before);
  });

  it('compiles selected project overrides before materializing any configuration or bundle prompts', () => {
    const root = mkdtempSync(join(tmpdir(), 'init-invalid-prompt-'));
    const prompts = join(root, '.saivage/config/prompts/process/_shared');
    mkdirSync(prompts, { recursive: true });
    writeFileSync(join(prompts, 'plan.md'), '');
    const result = init(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must contain non-whitespace UTF-8 text');
    expect(existsSync(join(root, '.saivage/saivage.yaml'))).toBe(false);
    expect(existsSync(join(root, '.saivage/config/template.json'))).toBe(false);
    expect(existsSync(join(root, '.saivage/config/prompts/agents'))).toBe(false);
    expect(existsSync(join(root, '.saivage/cards'))).toBe(false);
  });

  it('does not invent fresh native defaults or reinterpret flags as OFF configuration', () => {
    for (const args of [['--profile', 'classic-git'], values]) {
      const root = mkdtempSync(join(tmpdir(), 'init-native-values-'));
      const result = init(root, args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(args === values ? 'requires explicit --profile classic-git' : 'requires all four --git-*');
      expect(existsSync(join(root, '.saivage/saivage.yaml'))).toBe(false);
      expect(existsSync(join(root, '.saivage/config/template.json'))).toBe(false);
      expect(existsSync(join(root, '.saivage/cards'))).toBe(false);
    }
  });
});

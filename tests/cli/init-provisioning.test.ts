import { describe, expect, it, jest } from '@jest/globals';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { parse } from 'yaml';
import { resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { createResolvedConfigAuthority } from '../../src/config/resolved-config-authority.js';
import { readCard } from '../../src/persistence/card-files.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';

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
function promptFiles(root:string):string[] {
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
    const path=join(root,entry.name);
    return entry.isDirectory()?promptFiles(path):[path];
  }).sort();
}

describe('init provisioning before-effects admission', () => {
  it('materializes and bootstraps the complete typed default through no-profile public init',()=>{
    const root=mkdtempSync(join(tmpdir(),'init-default-'));
    const result=init(root);
    if(result.status!==0)throw new Error(result.stderr);
    const configPath=join(root,'.saivage/saivage.yaml');
    const config=parse(readFileSync(configPath,'utf8'));
    expect(config.card_types).toEqual(resolveSystemTemplate('classic-typed').config.card_types);
    expect(config.git_workflow?.enabled??false).toBe(false);
    expect(JSON.parse(readFileSync(join(root,'.saivage/config/template.json'),'utf8')).template).toBe('classic-typed');
    const observed:string[]=[];
    const effective=createResolvedConfigAuthority({path:configPath,projectRoot:root,interpolationEnvironment:{}}).loadEffective();
    const workflows=compileProjectWorkflows(effective.config,{projectRoot:root,artifactObserver:artifact=>observed.push(artifact.path)});
    expect(workflows.cardTypes.get('code')!.states.has('node:red')).toBe(true);
    expect(workflows.cardTypes.get('test')!.states.has('node:diagnose')).toBe(true);
    expect(workflows.cardTypes.get('architecture')!.states.has('node:component-review')).toBe(true);
    expect([...new Set(observed)].sort()).toEqual(promptFiles(join(root,'.saivage/config/prompts')));
    expect(readCard(root,'project')).toMatchObject({id:'project',type:'project'});
  });
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
  it.each(['classic', 'classic-typed', 'paad-typed', 'newloop', 'newloop2'])('preserves existing %s selection without default reselection and refuses explicit profile conflicts', (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'init-profile-'));
    expect(init(root, ['--profile', profile]).status).toBe(0);
    const configPath = join(root, '.saivage/saivage.yaml');
    const metadata = join(root, '.saivage/config/template.json');
    const head = join(root, '.saivage/cards/project/card-head.json');
    const paths=[configPath, metadata, head,...promptFiles(join(root,'.saivage/config/prompts'))];
    const before = paths.map(path => readFileSync(path));
    expect(before[1]!.toString()).toContain(profile);
    if(profile==='newloop2') {
      expect(before[0]!.toString()).toContain('frame-plan');
      expect(before[0]!.toString()).toContain('debt-assessment');
      expect(existsSync(join(root,'.saivage/config/prompts/process/_shared/debt-assessment.md'))).toBe(true);
      expect(existsSync(join(root,'.saivage/config/prompts/process/ops/ops-execute.md'))).toBe(true);
    }
    expect(init(root).status).toBe(0);
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    expect(init(root,['--profile',profile]).status).toBe(0);
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    const conflict = init(root, ['--profile', profile==='classic'?'classic-typed':'classic']);
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('conflicts with the existing template selection');
    expect(paths.map(path => readFileSync(path))).toEqual(before);
    const native = init(root, values);
    expect(native.status).toBe(1);
    expect(native.stderr).toContain('existing OFF configuration');
    expect(paths.map(path => readFileSync(path))).toEqual(before);
  });

  it.each([undefined,'classic'] as const)('compiles selected %s overrides before materializing any configuration or bundle prompts', (profile) => {
    const root = mkdtempSync(join(tmpdir(), 'init-invalid-prompt-'));
    const prompts = join(root, '.saivage/config/prompts/process/_shared');
    mkdirSync(prompts, { recursive: true });
    const path=join(prompts, profile==='classic'?'plan.md':'specialized-plan.md');
    writeFileSync(path, '');
    const result = init(root,profile?['--profile',profile]:[]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must contain non-whitespace UTF-8 text');
    expect(existsSync(join(root, '.saivage/saivage.yaml'))).toBe(false);
    expect(existsSync(join(root, '.saivage/config/template.json'))).toBe(false);
    expect(existsSync(join(root, '.saivage/config/prompts/agents'))).toBe(false);
    expect(existsSync(join(root, '.saivage/cards'))).toBe(false);
    expect(promptFiles(join(root,'.saivage/config/prompts'))).toEqual([path]);
  });

  it('rejects native provisioning for fresh newloop before materialization', () => {
    const root = mkdtempSync(join(tmpdir(), 'init-newloop-off-'));
    const result = init(root, ['--profile', 'newloop', ...values]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Native provisioning options cannot select an OFF profile');
    for (const path of ['saivage.yaml', 'config/template.json', 'cards']) expect(existsSync(join(root,'.saivage',path))).toBe(false);
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

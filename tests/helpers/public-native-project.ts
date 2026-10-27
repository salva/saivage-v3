import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

export const nativeCli = resolve('src/cli.ts');
export const nativeLoader = createRequire(import.meta.url).resolve('tsx');
export const nativeIdentity = { GIT_AUTHOR_NAME:'Public fixture', GIT_AUTHOR_EMAIL:'fixture@example.invalid',
  GIT_COMMITTER_NAME:'Public fixture', GIT_COMMITTER_EMAIL:'fixture@example.invalid' };
export const nativeOptions = ['--profile','classic-git','--git-delivery-branch','main',
  '--git-private-ref-namespace','refs/saivage/public','--git-source-roots','["."]',
  '--git-excluded-paths','[".git",".saivage"]'];
export function publicNativeCli(root: string, ...args: string[]) {
  return spawnSync(process.execPath,['--import',nativeLoader,nativeCli,...args],{
    cwd:root,env:{...process.env,...nativeIdentity},encoding:'utf8',timeout:30000,killSignal:'SIGKILL',
  });
}
export function fixtureGit(root: string,...args:string[]) {
  const result=spawnSync('git',args,{cwd:root,env:{...process.env,...nativeIdentity},encoding:'utf8',timeout:5000});
  if(result.status!==0 || result.error) throw new Error(`Fixture Git ${args[0]}: ${result.stderr}`);
  return result.stdout.trim();
}
export function publicNativeProject() {
  const root=mkdtempSync(join(tmpdir(),'public-native-'));
  fixtureGit(root,'init','-b','main');
  writeFileSync(join(root,'.gitignore'),'.saivage/\n');
  writeFileSync(join(root,'source.txt'),'delivery\n');
  fixtureGit(root,'add','--all');fixtureGit(root,'commit','-m','Fixture delivery');
  return root;
}

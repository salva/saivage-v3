import { expect, it, jest } from '@jest/globals';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';
import { nativeCli, nativeLoader, nativeIdentity, nativeOptions, publicNativeCli, publicNativeProject, fixtureGit } from '../helpers/public-native-project.js';
import { materializeSystemTemplate, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { readCard } from '../../src/persistence/card-files.js';
import { readCardExecutions } from '../../src/persistence/card-execution-log.js';
import { createProjectIdentity } from '../../src/persistence/project-identity.js';
import { startApp } from '../../src/boot/app.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

jest.setTimeout(120000);
function successful(result: ReturnType<typeof publicNativeCli>) {
  if(result.status!==0 || result.error) throw new Error(`CLI failed: ${result.stderr}; ${result.error}`);
}
function preauthored(root:string) {
  createProjectIdentity(root,'Public create-runtime fixture');
  mkdirSync(join(root,'.saivage'),{recursive:true});
  const config=materializeSystemTemplate(resolveSystemTemplate('classic-git'),{
    delivery_branch:'main',private_ref_namespace:'refs/saivage/public',source_roots:['.'],excluded_paths:['.git','.saivage'],
  });
  config.models=structuredClone(TEST_SAIVAGE_CONFIG.models);
  config.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);
  config.compaction=structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  config.providers!.test!.baseUrl='http://127.0.0.1:1';
  config.providers!.test!.capabilities!.transportProtocol='openai-responses';
  config.providers!.test!.capabilities!.imageInput=true;
  writeFileSync(join(root,'.saivage/saivage.yaml'),stringify(config));
}
async function until(predicate:()=>boolean, limit=20000) {
  const end=Date.now()+limit;
  while(!predicate()) {if(Date.now()>end) throw new Error('Bounded fixture wait expired');await new Promise(r=>setTimeout(r,20));}
}
it('public reset refuses collision before deletion, then commissions a separately selected namespace without touching old refs',()=>{
  const root=publicNativeProject(); successful(publicNativeCli(root,'init',...nativeOptions));
  const original=readCard(root,'project')!;
  const paths=['cards/project/card-head.json','cards/project/records/executions.jsonl','agents/conversations/analyst/index.json'];
  const before=paths.map(p=>readFileSync(join(root,'.saivage',p)));
  const refused=publicNativeCli(root,'reset');
  expect(refused.status).toBe(1);expect(refused.stderr).toContain('already exists');
  expect(paths.map(p=>readFileSync(join(root,'.saivage',p)))).toEqual(before);
  const path=join(root,'.saivage/saivage.yaml');const config=parse(readFileSync(path,'utf8'));
  config.git_workflow.private_ref_namespace='refs/saivage/fresh-public';writeFileSync(path,stringify(config));
  successful(publicNativeCli(root,'reset'));
  const fresh=readCard(root,'project')!;
  expect(fresh.git!.branch_ref).toBe('refs/heads/saivage/fresh-public/project');
  expect(fixtureGit(root,'rev-parse',original.git!.branch_ref)).toBe(original.git!.observed_tip);
  expect(fixtureGit(root,'symbolic-ref','HEAD')).toBe('refs/heads/main');
  expect(readCardExecutions(root,'project').at(-1)).toMatchObject({outcome:'commissioned'});
  expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(false);
});

it('public startup creates the absent runtime from the actual preauthored bundle before publishing readiness',async()=>{
  const root=publicNativeProject();preauthored(root);
  const tip=fixtureGit(root,'rev-parse','HEAD');
  const app=await startApp({projectRoot:root,createRuntime:true,env:{...process.env,SAIVAGE_HOST:'127.0.0.1',SAIVAGE_PORT:'0'}});
  try {
    const card=readCard(root,'project')!;
    expect(card.lifecycle.status).toBe('backlog');expect(card.git!.observed_tip).toBe(tip);
    expect(fixtureGit(root,'rev-parse',card.git!.branch_ref)).toBe(tip);
    expect(fixtureGit(root,'symbolic-ref','HEAD')).toBe('refs/heads/main');
    expect((await fetch(`http://127.0.0.1:${app.boundListener.port}/health`,{signal:AbortSignal.timeout(5000)})).status).toBe(200);
    const rows=readCardExecutions(root,'project');
    expect(rows.filter(row=>row.kind==='native_started').every(row=>row.kind==='native_started'&&row.binding.origin==='bootstrap')).toBe(true);
    expect(rows.at(-1)).toMatchObject({kind:'native_finished',outcome:'commissioned'});
  } finally {await app.stop();}
  expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(false);
});

it('public init refuses a ref-only collision and then refuses a rootless failed commission without replay',()=>{
  const collision=publicNativeProject();
  fixtureGit(collision,'update-ref','refs/heads/saivage/public/project',fixtureGit(collision,'rev-parse','HEAD'));
  const refused=publicNativeCli(collision,'init',...nativeOptions);
  expect(refused.status).toBe(1);expect(refused.stderr).toContain('already exists');
  expect(existsSync(join(collision,'.saivage/cards'))).toBe(false);
  const root=publicNativeProject();
  const hook=join(root,'.git/hooks/reference-transaction');
  writeFileSync(hook,'#!/bin/sh\nif [ "$1" = prepared ]; then echo invoked >> .saivage/hook-calls; exit 1; fi\n');chmodSync(hook,0o755);
  expect(publicNativeCli(root,'init',...nativeOptions).status).toBe(1);
  const calls=readFileSync(join(root,'.saivage/hook-calls'));
  expect(existsSync(join(root,'.saivage/cards/project/card-head.json'))).toBe(false);
  for(const args of [['init'],['start','--create-runtime','--host','127.0.0.1','--port','0']]) {
    const again=publicNativeCli(root,...args);expect(again.status).toBe(1);expect(again.stderr).toContain('generated state exists');
  }
  expect(readFileSync(join(root,'.saivage/hook-calls'))).toEqual(calls);
});

it('public start create-runtime holds exclusion and publishes no readiness during a real hook, then SIGTERM joins containment',async()=>{
  const root=publicNativeProject();preauthored(root);
  const hook=join(root,'.git/hooks/reference-transaction');
  writeFileSync(hook,'#!/bin/sh\nif [ "$1" = prepared ]; then trap "sleep 1; exit 0" TERM; echo $$ > .saivage/hook-pid; sleep 40 & wait; echo escaped > .saivage/late-hook; fi\n');chmodSync(hook,0o755);
  const child=spawn(process.execPath,['--import',nativeLoader,nativeCli,'start','--create-runtime','--host','127.0.0.1','--port','0'],{
    cwd:root,env:{...process.env,...nativeIdentity},stdio:['ignore','pipe','pipe'],
  });
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const exit=new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
  let exited=false;void exit.then(()=>{exited=true;});
  try {
    await until(()=>existsSync(join(root,'.saivage/hook-pid'))||exited);
    if(exited) throw new Error(`Startup exited before hook: ${stderr}`);
    const lock=JSON.parse(readFileSync(join(root,'.saivage/locks/runtime.lock'),'utf8'));
    expect(lock).not.toBeNull();
    expect(existsSync(join(root,'.saivage/cards/project/card-head.json'))).toBe(false);
    expect(stdout).not.toMatch(/listening|ready|http:\/\//i);
    child.kill('SIGTERM');
    await new Promise(r=>setTimeout(r,75));
    expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(true);
    await until(()=>exited,30000);await exit;
    expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(false);
    expect(existsSync(join(root,'.saivage/late-hook'))).toBe(false);
    const pid=Number(readFileSync(join(root,'.saivage/hook-pid'),'utf8').trim());
    expect(()=>process.kill(pid,0)).toThrow();
    expect(existsSync(join(root,'.saivage/cards/project/card-head.json'))).toBe(false);
    expect(stdout).not.toMatch(/listening|ready|http:\/\//i);
    const again=publicNativeCli(root,'init');expect(again.status).toBe(1);expect(again.stderr).toContain('generated state exists');
  } finally {
    if(!exited) {child.kill('SIGTERM');await until(()=>exited,50000);await exit;}
    writeFileSync(join(root,'.saivage/public-start-receipt.json'),JSON.stringify({stdout,stderr,exited}));
  }
});

it.each(['publication','unverifiable'] as const)('actual startup %s fatal boundary retains exclusion without readiness',async scenario=>{
  const root=publicNativeProject();preauthored(root);
  if(scenario==='unverifiable') {
    const hook=join(root,'.git/hooks/reference-transaction');
    writeFileSync(hook,'#!/bin/sh\nif [ "$1" = prepared ]; then echo $$ > .saivage/hook-pid; sleep 2; fi\n');chmodSync(hook,0o755);
  }
  const result=spawnSync(process.execPath,['--import',nativeLoader,resolve('tests/fixtures/native-public-startup-fault.ts'),scenario,root],{
    cwd:process.cwd(),env:{...process.env,...nativeIdentity},encoding:'utf8',timeout:30000,killSignal:'SIGKILL',
  });
  expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  expect(result.stdout).toContain(scenario==='publication'?'NATIVE_PUBLICATION_UNCERTAIN':'NATIVE_GROUP_UNVERIFIABLE');
  expect(result.stdout).not.toContain('FORBIDDEN_');
  expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(true);
  expect(existsSync(join(root,'.saivage/cards/project/card-head.json'))).toBe(false);
  if(scenario==='unverifiable') {
    const pid=Number(readFileSync(join(root,'.saivage/hook-pid'),'utf8'));
    await until(()=>{try{process.kill(pid,0);return false;}catch{return true;}},10000);
  }
  writeFileSync(join(root,'.saivage/public-fatal-receipt.json'),JSON.stringify({scenario,status:result.status,stdout:result.stdout,stderr:result.stderr}));
});

it.each([
  ['layout','ordinary'],['session','ordinary'],['session','unknown'],
  ['evidence-start','ordinary'],['evidence-start','unknown'],['onSpawn','unknown'],
  ['capture-append','unknown'],['process-finish','unknown'],['evidence-finish','unknown'],
  ['records','ordinary'],['records','unknown'],['artifact','ordinary'],['artifact','unknown'],
  ['head','ordinary'],['head','unknown'],['final-admission','ordinary'],
] as const)('bootstrap %s / %s stops at the actual syscall frontier', (point,mode)=>{
  const root=publicNativeProject();preauthored(root);
  const result=spawnSync(process.execPath,['--import',nativeLoader,resolve('tests/fixtures/native-public-startup-fault.ts'),`frontier:${point}:${mode}`,root],{
    cwd:process.cwd(),env:{...process.env,...nativeIdentity},encoding:'utf8',timeout:30000,killSignal:'SIGKILL',
  });
  writeFileSync(join(root,'.saivage/bootstrap-frontier-receipt.json'),JSON.stringify({point,mode,status:result.status,signal:result.signal,error:String(result.error),stdout:result.stdout,stderr:result.stderr}));
  expect(result.error).toBeUndefined();expect(result.status).not.toBe(0);
  expect(result.stdout).toContain(`FRONTIER:${point}:${mode}`);
  expect(result.stdout).not.toContain('FORBIDDEN_');
  expect(result.stdout).not.toContain('Server listening');
  expect(existsSync(join(root,'.saivage/locks/runtime.lock'))).toBe(mode==='unknown');
  expect(existsSync(join(root,'.saivage/cards/project/card-head.json'))).toBe(point==='final-admission'||(point==='head'&&mode==='unknown'));
  // A post-head ordinary admission error is not an absent-root retry case.
  if(mode==='ordinary'&&point!=='final-admission') {
    const retry=publicNativeCli(root,'init');expect(retry.status).toBe(1);
    expect(retry.stderr).toContain('generated state exists');
  }
});

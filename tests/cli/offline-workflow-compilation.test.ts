import { afterEach,describe,expect,it,jest } from '@jest/globals';
import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join } from 'node:path';
import * as YAML from 'yaml';
import { run } from '../../src/cli.js';
import { DEFAULT_SAIVAGE_CONFIG } from '../../src/agents/default-workflow-config.js';
import { createProjectIdentity,readProjectIdentity } from '../../src/persistence/project-identity.js';
import { readCard } from '../../src/persistence/card-files.js';

const roots:string[]=[];const cwd=process.cwd();afterEach(()=>{process.chdir(cwd);jest.restoreAllMocks();while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'offline-workflow-'));roots.push(value);return value;}
function write(path:string,content:string){mkdirSync(dirname(path),{recursive:true});writeFileSync(path,content);}
async function command(projectRoot:string,name:string,...args:string[]){process.chdir(projectRoot);await run(['node','saivage',name,...args]);}

describe('offline workflow compilation and publication',()=>{
  it('init publishes defaults only when absent and validates before identity/card publication',async()=>{const projectRoot=root();jest.spyOn(console,'log').mockImplementation(()=>{});await command(projectRoot,'init');const configPath=join(projectRoot,'.saivage','saivage.yaml');const bytes=readFileSync(configPath);expect(readCard(projectRoot,'project')).toMatchObject({id:'project',type:'project'});await command(projectRoot,'init');expect(readFileSync(configPath)).toEqual(bytes);
    const invalidRoot=root();write(join(invalidRoot,'.saivage','saivage.yaml'),YAML.stringify({...structuredClone(DEFAULT_SAIVAGE_CONFIG),unknown_old_contract:true}));await expect(command(invalidRoot,'init')).rejects.toThrow(/Configuration validation failed/);expect(readProjectIdentity(invalidRoot)).toBeNull();expect(existsSync(join(invalidRoot,'.saivage','cards'))).toBe(false);
  });

  it('uses a precompiled custom project bootstrap definition',async()=>{const projectRoot=root();const config=structuredClone(DEFAULT_SAIVAGE_CONFIG);config.card_types.project!.records['charter.md']={...config.card_types.project!.records['brief.md']!,bootstrap:true};delete config.card_types.project!.records['brief.md'];write(join(projectRoot,'.saivage','saivage.yaml'),YAML.stringify(config));jest.spyOn(console,'log').mockImplementation(()=>{});await command(projectRoot,'init');expect(existsSync(join(projectRoot,'.saivage','cards','project','charter.jsonl'))).toBe(true);expect(existsSync(join(projectRoot,'.saivage','cards','project','brief.jsonl'))).toBe(false);});

  it('reset and start --create-runtime reject absent config before deleting or publishing generated state',async()=>{const projectRoot=root();createProjectIdentity(projectRoot,'offline-test');const marker=join(projectRoot,'.saivage','cards','retained.bin');write(marker,'retained');jest.spyOn(console,'log').mockImplementation(()=>{});await expect(command(projectRoot,'reset')).rejects.toThrow(/Configuration not found/);expect(readFileSync(marker,'utf8')).toBe('retained');const startRoot=root();createProjectIdentity(startRoot,'start-test');await expect(command(startRoot,'start','--project-root',startRoot,'--create-runtime')).rejects.toThrow(/Configuration validation failed/);expect(existsSync(join(startRoot,'.saivage','cards'))).toBe(false);});
});

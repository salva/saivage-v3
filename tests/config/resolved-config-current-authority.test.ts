import { afterEach,describe,expect,it } from '@jest/globals';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestConfigAuthority } from '../helpers/project-config.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'resolved-config-current-'));roots.push(value);return value;}

describe('restart-only resolved configuration authority',()=>{
  it('validates the complete candidate before replacement and never mutates the current compiled artifact',()=>{const projectRoot=root();const authority=createTestConfigAuthority(projectRoot);const current=authority.loadEffective();const result=authority.applyChange({kind:'set_agent_model_route',agent:'analyst',modelRoute:'executor'});expect(result).toMatchObject({success:true,requires_restart:true});expect(current.workflows.analyst.modelRoute).toBe('analyst');expect(authority.loadEffective().workflows.analyst.modelRoute).toBe('executor');expect(current.workflows).not.toBe(authority.loadEffective().workflows);});
  it('leaves exact file bytes unchanged for unknown agents, routes, and failover candidates',()=>{const projectRoot=root();const authority=createTestConfigAuthority(projectRoot);const before=readFileSync(authority.path);expect(authority.applyChange({kind:'set_agent_model_route',agent:'missing',modelRoute:'executor'}).success).toBe(false);expect(readFileSync(authority.path)).toEqual(before);expect(authority.applyChange({kind:'set_model_failover',forModel:'missing-model',orderedFailoverModels:[]}).success).toBe(false);expect(readFileSync(authority.path)).toEqual(before);});
});

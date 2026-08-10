import { afterEach,describe,expect,it } from '@jest/globals';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'resolved-config-current-'));roots.push(value);return value;}

describe('restart-only resolved configuration authority',()=>{
  it('preserves explicit nested model-equivalence arrays exactly',()=>{const config=structuredClone(TEST_SAIVAGE_CONFIG);config.models.equivalents=[['base-model','equivalent-model'],['other-model']];const effective=createTestConfigAuthority(root(),{config}).loadEffective();expect(effective.config.models.equivalents).toEqual([['base-model','equivalent-model'],['other-model']]);});
  it('rejects a legacy string-valued model-equivalence mapping at the selected YAML boundary',()=>{const config={...structuredClone(TEST_SAIVAGE_CONFIG),models:{...structuredClone(TEST_SAIVAGE_CONFIG.models),equivalents:{'base-model':'equivalent-model'}}};const authority=createTestConfigAuthority(root(),{config});expect(()=>authority.loadEffective()).toThrow(/Configuration validation failed: models\/equivalents:/);});
  it('rejects a complete model-equivalence mapping when one member was formerly discarded',()=>{const config={...structuredClone(TEST_SAIVAGE_CONFIG),models:{...structuredClone(TEST_SAIVAGE_CONFIG.models),equivalents:{'base-model':['equivalent-model'],malformed:7}}};const authority=createTestConfigAuthority(root(),{config});expect(()=>authority.loadEffective()).toThrow(/Configuration validation failed: models\/equivalents:/);});
  it('validates the complete candidate before replacement and never mutates the current compiled artifact',()=>{const projectRoot=root();const authority=createTestConfigAuthority(projectRoot);const current=authority.loadEffective();const result=authority.applyChange({kind:'set_agent_model_route',agent:'analyst',modelRoute:'executor'});expect(result).toMatchObject({success:true,requires_restart:true});expect(current.workflows.analyst.modelRoute).toBe('analyst');expect(authority.loadEffective().workflows.analyst.modelRoute).toBe('executor');expect(current.workflows).not.toBe(authority.loadEffective().workflows);});
  it('leaves exact file bytes unchanged for unknown agents, routes, and failover candidates',()=>{const projectRoot=root();const authority=createTestConfigAuthority(projectRoot);const before=readFileSync(authority.path);expect(authority.applyChange({kind:'set_agent_model_route',agent:'missing',modelRoute:'executor'}).success).toBe(false);expect(readFileSync(authority.path)).toEqual(before);expect(authority.applyChange({kind:'set_model_failover',forModel:'missing-model',orderedFailoverModels:[]}).success).toBe(false);expect(readFileSync(authority.path)).toEqual(before);});
});

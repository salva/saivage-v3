import { afterEach,describe,expect,it } from '@jest/globals';
import { cpSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { specializedCardTypes } from '../helpers/specialized-config.js';
import { DEFAULT_SAIVAGE_CONFIG, resolveSystemTemplate } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema, saivageConfigSchema } from '../../src/schemas/index.js';
import type { ConfigMutation } from '../../src/config/resolved-config-authority.js';
import * as YAML from 'yaml';

const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});
function root(){const value=mkdtempSync(join(tmpdir(),'resolved-config-current-'));roots.push(value);return value;}
function materializeClassicTypedPrompts(projectRoot:string){cpSync(resolveSystemTemplate('classic-typed').promptRoot,join(projectRoot,'.saivage','config','prompts'),{recursive:true});}

describe('restart-only resolved configuration authority',()=>{
  it('resolves omitted and explicit classic definitions to the same effective configuration',()=>{const globals=structuredClone(DEFAULT_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;const omitted=createTestConfigAuthority(root(),{config:globals}).loadEffective();const explicit=createTestConfigAuthority(root(),{config:DEFAULT_SAIVAGE_CONFIG}).loadEffective();expect(omitted.config).toEqual(DEFAULT_SAIVAGE_CONFIG);expect(explicit.config).toEqual(DEFAULT_SAIVAGE_CONFIG);expect(omitted.workflows.cardTypeVocabulary).toEqual(explicit.workflows.cardTypeVocabulary);expect([...omitted.workflows.cardTypes.keys()]).toEqual([...explicit.workflows.cardTypes.keys()]);});
  it('selects a complete immutable-cloned specialized map without changing the default',()=>{const projectRoot=root();materializeClassicTypedPrompts(projectRoot);const globals=structuredClone(DEFAULT_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;const specialized=createTestConfigAuthority(projectRoot,{config:{...globals,card_types:specializedCardTypes()}}).loadEffective();expect(specialized.config.card_types).toEqual(resolveSystemTemplate('classic-typed').config.card_types);expect(specialized.workflows.cardTypeVocabulary).toEqual(['project','goal','architecture','code','test','doc','data','research','ops']);specialized.config.card_types.project!.permitted_child_types.pop();expect(resolveSystemTemplate('classic-typed').config.card_types!.project!.permitted_child_types).toHaveLength(8);expect(createTestConfigAuthority(root(),{config:globals}).loadEffective().config).toEqual(DEFAULT_SAIVAGE_CONFIG);});
  it('rejects the deleted card_type_set selector as an unknown source key without fallback or merge',()=>{const globals=structuredClone(DEFAULT_SAIVAGE_CONFIG) as Record<string,unknown>;delete globals.card_types;expect(()=>createTestConfigAuthority(root(),{config:{...globals,card_type_set:'standard'}}).loadEffective()).toThrow(/card_type_set/);expect(()=>createTestConfigAuthority(root(),{config:{...globals,card_type_set:'unknown'}}).loadEffective()).toThrow(/card_type_set/);expect(()=>createTestConfigAuthority(root(),{config:{...globals,card_type_set:'standard',card_types:structuredClone(DEFAULT_SAIVAGE_CONFIG.card_types)}}).loadEffective()).toThrow(/card_type_set/);});
  it('preserves explicit nested model-equivalence arrays exactly',()=>{const config=structuredClone(TEST_SAIVAGE_CONFIG);config.models.equivalents=[['base-model','equivalent-model'],['other-model']];const effective=createTestConfigAuthority(root(),{config}).loadEffective();expect(effective.config.models.equivalents).toEqual([['base-model','equivalent-model'],['other-model']]);});
  it('rejects a legacy string-valued model-equivalence mapping at the selected YAML boundary',()=>{const config={...structuredClone(TEST_SAIVAGE_CONFIG),models:{...structuredClone(TEST_SAIVAGE_CONFIG.models),equivalents:{'base-model':'equivalent-model'}}};const authority=createTestConfigAuthority(root(),{config});expect(()=>authority.loadEffective()).toThrow(/Configuration validation failed: models\/equivalents:/);});
  it('rejects a complete model-equivalence mapping when one member was formerly discarded',()=>{const config={...structuredClone(TEST_SAIVAGE_CONFIG),models:{...structuredClone(TEST_SAIVAGE_CONFIG.models),equivalents:{'base-model':['equivalent-model'],malformed:7}}};const authority=createTestConfigAuthority(root(),{config});expect(()=>authority.loadEffective()).toThrow(/Configuration validation failed: models\/equivalents:/);});
  it('validates the complete candidate before replacement and never mutates the current compiled artifact',()=>{const projectRoot=root();const authority=createTestConfigAuthority(projectRoot);const current=authority.loadEffective();const result=authority.applyChange({kind:'set_agent_model_route',agent:'analyst',modelRoute:'executor'});expect(result).toMatchObject({success:true,requires_restart:true});expect(current.workflows.analyst.modelRoute).toBe('analyst');expect(authority.loadEffective().workflows.analyst.modelRoute).toBe('executor');expect(current.workflows).not.toBe(authority.loadEffective().workflows);});
  it('corrects a schema-valid compiler-only current error while ordinary reads still reject it', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents.analyst!.model_route = 'missing-route';
    expect(saivageConfigSchema.safeParse(config).success).toBe(true);
    expect(effectiveSaivageConfigSchema.safeParse(config).success).toBe(true);
    const authority = createTestConfigAuthority(root(), { config });
    expect(() => authority.loadEffective()).toThrow("agents.analyst.model_route references missing route 'missing-route'.");
    expect(authority.applyChange({ kind: 'set_agent_model_route', agent: 'analyst', modelRoute: 'executor' }))
      .toMatchObject({ success: true, requires_restart: true, config: { agents: { analyst: { model_route: 'executor' } } } });
    expect(YAML.parse(readFileSync(authority.path, 'utf8')).agents.analyst.model_route).toBe('executor');
    expect(authority.loadEffective().workflows.analyst.modelRoute).toBe('executor');
  });

  it('rejects a candidate that retains the compiler-only defect without replacing selected bytes', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.agents.analyst!.model_route = 'missing-route';
    const authority = createTestConfigAuthority(root(), { config });
    const before = readFileSync(authority.path);
    expect(authority.applyChange({ kind: 'set_server_setting', key: 'port', value: 8181 }))
      .toEqual({ success: false, fieldPath: '/', message: "agents.analyst.model_route references missing route 'missing-route'." });
    expect(readFileSync(authority.path)).toEqual(before);
  });

  it('rejects schema-invalid current data before even a correcting edit', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG);
    config.server.port = -1;
    const authority = createTestConfigAuthority(root(), { config });
    const before = readFileSync(authority.path);
    expect(authority.applyChange({ kind: 'set_server_setting', key: 'port', value: 8181 }))
      .toMatchObject({ success: false, fieldPath: 'server/port', message: expect.stringContaining('Configuration validation failed: server/port:') });
    expect(readFileSync(authority.path)).toEqual(before);
  });

  it.each<[ConfigMutation, string, string]>([
    [{ kind: 'set_agent_model_route', agent: 'missing', modelRoute: 'executor' }, 'agents/missing', "Unknown agent 'missing'."],
    [{ kind: 'set_agent_model_route', agent: 'analyst', modelRoute: 'missing-route' }, 'models/routes/missing-route', "Unknown model route 'missing-route'."],
    [{ kind: 'set_model_failover', forModel: 'missing-model', orderedFailoverModels: [] }, 'models/failover/missing-model', "Unknown model 'missing-model'."],
    [{ kind: 'set_model_failover', forModel: 'test-model', orderedFailoverModels: ['missing-target'] }, 'models/failover/test-model', "Unknown failover model 'missing-target'."],
  ])('denies unsupported membership without publication: %j', (mutation, fieldPath, message) => {
    const authority = createTestConfigAuthority(root());
    const before = readFileSync(authority.path);
    expect(authority.applyChange(mutation)).toEqual({ success: false, fieldPath, message });
    expect(readFileSync(authority.path)).toEqual(before);
  });

  it('preserves source comments, placeholders and omitted card types and returns only frozen candidate warnings', () => {
    const config = structuredClone(TEST_SAIVAGE_CONFIG) as Record<string, unknown>;
    delete config.card_types;
    config.server = { port: 8080, host: '${UNSET_HOST}' };
    config.providers = { ...TEST_SAIVAGE_CONFIG.providers, test: { ...TEST_SAIVAGE_CONFIG.providers.test, apiKey: '${UNSET_KEY}', baseUrl: '${TEST_ENDPOINT}' } };
    const authority = createTestConfigAuthority(root(), { config, environment: { TEST_ENDPOINT: 'https://example.invalid/v1' } });
    writeFileSync(authority.path, `# unrelated operator comment\n${readFileSync(authority.path, 'utf8')}`);
    expect(authority.loadEffective().warnings).toEqual([
      "Environment variable 'UNSET_KEY' is not set.",
      "Environment variable 'UNSET_HOST' is not set.",
    ]);
    const result = authority.applyChange({ kind: 'set_server_setting', key: 'host', value: '127.0.0.1' });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.message);
    expect(result.warnings).toEqual(["Environment variable 'UNSET_KEY' is not set."]);
    expect(Object.isFrozen(result.warnings)).toBe(true);
    expect(result.config.card_types).toEqual(DEFAULT_SAIVAGE_CONFIG.card_types);
    expect(result.config.providers.test!.baseUrl).toBe('https://example.invalid/v1');
    const source = readFileSync(authority.path, 'utf8');
    expect(source).toContain('# unrelated operator comment');
    expect(source).toContain('${UNSET_KEY}');
    expect(source).toContain('${TEST_ENDPOINT}');
    expect(YAML.parse(source)).not.toHaveProperty('card_types');
    expect(YAML.parse(source).server.host).toBe('127.0.0.1');
  });
});

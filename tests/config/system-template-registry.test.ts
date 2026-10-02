import { describe,expect,it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SAIVAGE_CONFIG,DEFAULT_SYSTEM_TEMPLATE,SYSTEM_TEMPLATES,resolveSystemTemplate,validateSystemTemplates } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { createClassicConfig } from '../../src/config/system-templates/classic-shared.js';
import { OVERSIGHT_ALLOWED_TOOL_NAMES } from '../../src/contracts/index.js';
import { minimalSystemTemplate,secondSystemTemplate } from '../fixtures/system-templates/minimal.js';
import { compileProjectWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { createPromptTemplateRegistry } from '../../src/utils/prompt-api.js';
// @ts-expect-error Packaging tooling is JavaScript without a TypeScript declaration.
import { assertClassicFamilyPromptParity } from '../../scripts/copy-system-template-prompts.js';

describe('system template registry',()=>{
  it('registers exactly classic then classic-typed with module-relative prompt roots',()=>{
    expect(SYSTEM_TEMPLATES.map((template)=>template.name)).toEqual(['classic','classic-typed']);
    expect(DEFAULT_SYSTEM_TEMPLATE).toBe('classic');
    for(const template of SYSTEM_TEMPLATES){
      const moduleDirectory=join(fileURLToPath(new URL('.',import.meta.url)),'..','..','src','config','system-templates',template.name);
      expect(resolve(template.promptRoot)).toBe(resolve(join(moduleDirectory,'prompts')));
    }
  });

  it('accepts the registered templates at load-time validation',()=>{
    expect(()=>validateSystemTemplates(SYSTEM_TEMPLATES)).not.toThrow();
  });
  it.each([0,-1,Number.POSITIVE_INFINITY])('rejects invalid required Oversight interval %s',(interval)=>{const value=structuredClone(resolveSystemTemplate('classic').config);value.oversight.interval_seconds=interval;expect(effectiveSaivageConfigSchema.safeParse(value).success).toBe(false);});

  it('load-time validation rejects duplicate names, empty names, and schema-invalid configs',()=>{
    const minimal=minimalSystemTemplate('/unused/prompts/');
    const second=secondSystemTemplate('/unused/prompts/');
    expect(()=>validateSystemTemplates([minimal,{...minimal,name:'minimal'}])).toThrow(/Duplicate or empty system template 'minimal'/);
    expect(()=>validateSystemTemplates([{...minimal,name:''}])).toThrow(/Duplicate or empty system template ''/);
    expect(()=>validateSystemTemplates([minimal,second])).not.toThrow();
    const invalid={...minimal,config:{...minimal.config,unknown_source_key:true} as typeof minimal.config};
    expect(()=>validateSystemTemplates([invalid])).toThrow();
    const selector={...minimal,config:{...minimal.config,card_type_set:'standard'} as typeof minimal.config};
    expect(()=>validateSystemTemplates([selector])).toThrow(/card_type_set/);
  });

  it('fails unknown names with the exact listing and profile field path',()=>{
    expect(()=>resolveSystemTemplate('nope')).toThrow("Unknown template 'nope'. Available templates: classic, classic-typed.");
    try { resolveSystemTemplate('Standard'); } catch (error) {
      expect((error as Error & { fieldPath?: string }).fieldPath).toBe('profile');
    }
  });

  it('keeps template configs deeply frozen and isolated from derived effective clones',()=>{
    const classic=resolveSystemTemplate('classic');
    expect(resolveSystemTemplate('classic')).toBe(classic);
    expect(Object.isFrozen(classic.config)).toBe(true);
    expect(Object.isFrozen(classic.config.card_types)).toBe(true);
    expect(Object.isFrozen(classic.config.card_types!.project!.permitted_child_types)).toBe(true);
    expect(Object.isFrozen(classic.config.agents)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SAIVAGE_CONFIG)).toBe(true);
    expect(DEFAULT_SAIVAGE_CONFIG).not.toBe(classic.config);
    expect(DEFAULT_SAIVAGE_CONFIG).toEqual(effectiveSaivageConfigSchema.parse(structuredClone(classic.config)));
    const typedDerived=effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate('classic-typed').config));
    typedDerived.card_types.project!.permitted_child_types.pop();
    expect(resolveSystemTemplate('classic-typed').config.card_types!.project!.permitted_child_types).toHaveLength(8);
    expect(effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate('classic-typed').config)).card_types.project!.permitted_child_types).toHaveLength(8);
  });

  it('keeps distinct classic-family card graphs and byte-identical shared prompt closures',()=>{
    const classic=resolveSystemTemplate('classic');
    const typed=resolveSystemTemplate('classic-typed');
    expect(typed.config.card_types).not.toEqual(classic.config.card_types);
    expect(()=>assertClassicFamilyPromptParity({templates:SYSTEM_TEMPLATES})).not.toThrow();
  });

  it('materializes fresh typed classic config declarations and freezes the complete graph',()=>{
    const template=resolveSystemTemplate('classic');
    const firstGraph=structuredClone(template.config.card_types!);
    const secondGraph=structuredClone(template.config.card_types!);
    const first=createClassicConfig(firstGraph);
    const second=createClassicConfig(secondGraph);
    expect(first).toEqual(template.config);
    expect(second).toEqual(first);
    expect(first.agents).not.toBe(second.agents);
    expect(first.models.routes).not.toBe(second.models.routes);
    expect(first.agents.oversight!.tools).not.toBe(second.agents.oversight!.tools);
    expect(first.agents.oversight!.tools).toEqual(OVERSIGHT_ALLOWED_TOOL_NAMES);
    expect(first.card_types).toBe(firstGraph);
    expect(Object.isFrozen(firstGraph.project!.workflow.nodes)).toBe(true);
    expect(Object.isFrozen(first.agents.analyst!.tools)).toBe(true);
    expect(Object.isFrozen(first.models.routes)).toBe(true);
  });

  it('compiles each selected Executor with its observed guidance closure and one rendered outcome contract',()=>{
    for(const templateName of ['classic','classic-typed'] as const){
      const template=resolveSystemTemplate(templateName);const observed:string[]=[];
      const workflows=compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(template.config)),{defaultPromptRoot:template.promptRoot,artifactObserver:(artifact)=>observed.push(artifact.path)});
      const rendered=createPromptTemplateRegistry(workflows).render({kind:'workflow-agent',cardType:'code'},'executor',{contractDescription:'UNIQUE-OUTCOME-CONTRACT'});
      expect(rendered.split('UNIQUE-OUTCOME-CONTRACT')).toHaveLength(2);
      expect(observed.some((path)=>path.endsWith('/agents/_shared/executor.md'))).toBe(true);
      expect(observed.some((path)=>path.endsWith('/fragments/_shared/project-guidance-common.md'))).toBe(true);
      expect(observed.some((path)=>path.endsWith('/fragments/_shared/project-guidance-executor.md'))).toBe(true);
    }
  });

  it('ships exact Analyst notification-target guidance, source tokens, and role safety',()=>{
    for(const templateName of ['classic','classic-typed'] as const){
      const analyst=readFileSync(join(resolveSystemTemplate(templateName).promptRoot,'agents/_shared/analyst.md'),'utf8');
      expect(analyst).toContain('its configured designated recipient should resolve the issue');
      expect(analyst).not.toContain('its planner/executor should resolve the issue');
      expect(analyst).toContain('Prefer queue_notification with the exact card_id');
      expect(analyst).toContain('Roles and session IDs are not notification targets.');
      expect(analyst).toContain('Do not use shell commands to mutate source, deploy, run delivery builds/tests, or perform planner/executor work.');
      expect(analyst.match(/\{\{[^}]+\}\}/gu)).toEqual(['{{>project-guidance-common}}','{{>project-guidance-analyst}}','{{vocabularySnippet}}']);
      const oversight=readFileSync(join(resolveSystemTemplate(templateName).promptRoot,'agents/_shared/oversight.md'),'utf8');
      expect(oversight.match(/\{\{[^}]+\}\}/gu)).toEqual(['{{>project-guidance-common}}','{{>project-guidance-oversight}}','{{vocabularySnippet}}']);
      expect(oversight).toContain("read `section: \"context\"`");
    }
  });
});

import { describe,expect,it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SAIVAGE_CONFIG,DEFAULT_SYSTEM_TEMPLATE,SYSTEM_TEMPLATES,resolveSystemTemplate,validateSystemTemplates } from '../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { minimalSystemTemplate,secondSystemTemplate } from '../fixtures/system-templates/minimal.js';

const SHARED_PROMPT_FILES=[...['analyst','oversight','executor','planner','reviewer'].map((id)=>`agents/_shared/${id}.md`),...['execute','stopped-recovery','correct-plan-result','correct-review-result','correct-execution-result'].map((id)=>`process/_shared/${id}.md`),...['common','analyst','oversight','planner','executor','reviewer'].map((id)=>`fragments/_shared/project-guidance-${id}.md`)];

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

  it('keeps the classic family byte-identical outside card_types and in shared prompt files',()=>{
    const classic=resolveSystemTemplate('classic');
    const typed=resolveSystemTemplate('classic-typed');
    expect(typed.config.agents).toEqual(classic.config.agents);
    expect(typed.config.analyst_agent).toBe(classic.config.analyst_agent);
    expect(typed.config.oversight).toEqual(classic.config.oversight);
    expect(typed.config.models).toEqual(classic.config.models);
    expect(typed.config.providers).toEqual(classic.config.providers);
    expect(typed.config.server).toEqual(classic.config.server);
    expect(typed.config.compaction).toEqual(classic.config.compaction);
    expect(typed.config.card_types).not.toEqual(classic.config.card_types);
    for(const file of SHARED_PROMPT_FILES)expect(readFileSync(join(typed.promptRoot,file),'utf8')).toBe(readFileSync(join(classic.promptRoot,file),'utf8'));
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
    }
  });
});

import { agentExecution } from '../helpers/workflow-execution.js';
import { writeRecordPatterns } from '../helpers/capability-grants.js';
import { templateConfig } from '../helpers/system-template-config.js';
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
import { assertClassicFamilyPromptParity, assertPaadTypedPromptParity, assertNewloopPromptParity, collectTemplatePromptClosure } from '../../scripts/copy-system-template-prompts.js';

describe('system template registry',()=>{
  it('registers the profiles with isolated module-relative prompt roots',()=>{
    expect(SYSTEM_TEMPLATES.map((template)=>template.name)).toEqual(['classic','classic-typed','paad-typed','classic-git','newloop','newloop2']);
    expect(new Set(SYSTEM_TEMPLATES.map(template=>template.promptRoot)).size).toBe(SYSTEM_TEMPLATES.length);
    expect(DEFAULT_SYSTEM_TEMPLATE).toBe('classic');
    for(const template of SYSTEM_TEMPLATES){
      const moduleDirectory=join(fileURLToPath(new URL('.',import.meta.url)),'..','..','src','config','system-templates',template.name);
      expect(resolve(template.promptRoot)).toBe(resolve(join(moduleDirectory,'prompts')));
    }
  });

  it('accepts the registered templates at load-time validation',()=>{
    expect(()=>validateSystemTemplates(SYSTEM_TEMPLATES)).not.toThrow();
    for (const template of SYSTEM_TEMPLATES) {
      for (const type of Object.values(templateConfig(template).card_types!)) expect(type.workflow.format_version).toBe(7);
    }
  });

  it.each(SYSTEM_TEMPLATES.filter(template=>template.name!=='newloop2'))('compiles the scoped status/review starters and existing authorship authority in $name',template=>{
    const workflows=compileProjectWorkflows(effectiveSaivageConfigSchema.parse(templateConfig(template)),{defaultPromptRoot:template.promptRoot});
    const typed=template.name==='classic-typed'||template.name==='paad-typed'||template.name==='newloop';
    const statusNodes:Record<string,string[]>={
      project:['plan','recover','assess-completion'],goal:['plan','recover','handle-notifications'],
      architecture:typed?['draft']:['execute'],code:typed?['red','green','refactor']:['execute'],
      test:typed?['diagnose','add-coverage','repair','verify']:['execute'],
      research:typed?['explore','assess','report']:['execute'],data:typed?['schema','validate','implement']:['execute'],
      doc:['execute'],ops:['execute'],
    };
    for(const [cardType,workflow] of workflows.cardTypes){
      expect(workflow.bootstrapRecord.name).toBe('brief.md');
      expect(workflow.bootstrapRecord.initialization).toBeNull();
      const reviewNodes=cardType==='project'||cardType==='goal'?['review']:typed&&cardType==='architecture'?['component-review','system-review']:[];
      expect([...workflow.records.values()].filter(record=>record.initialization).map(record=>record.name).sort())
        .toEqual(reviewNodes.length?['review.md','status.md']:['status.md']);
      for(const node of workflow.states.values()){
        if(node.kind!=='node')continue;
        const status=statusNodes[cardType]!.includes(node.nodeId);
        const review=reviewNodes.includes(node.nodeId);
        expect(node.initializeRecords.map(record=>record.name)).toEqual(status?['status.md']:review?['review.md']:[]);
        for(const requirement of node.requirements){
          if(requirement.definition.name==='status.md')expect(requirement).toMatchObject({mode:'continue',gate:'updated'});
          if(requirement.definition.name==='review.md')expect(requirement).toMatchObject({mode:'clean',gate:'updated'});
        }
        if(status||review){
          expect(agentExecution(node).agent.tools.map(tool=>tool.name)).toContain('write');
          expect(writeRecordPatterns(agentExecution(node).agent).map(pattern=>pattern.source)).toContain(status?'status.md':'review.md');
        }
      }
      expect([...workflow.states.values()].filter(node=>node.kind==='node'&&node.initializeRecords.some(record=>record.name==='status.md')).map(node=>node.kind==='node'?node.nodeId:'').sort())
        .toEqual([...statusNodes[cardType]!].sort());
      expect([...workflow.states.values()].filter(node=>node.kind==='node'&&node.initializeRecords.some(record=>record.name==='review.md')).map(node=>node.kind==='node'?node.nodeId:'').sort())
        .toEqual([...reviewNodes].sort());
    }
    expect(writeRecordPatterns(workflows.agents.get('planner')!).map(pattern=>pattern.source)).toEqual(['status.md','brief.md']);
    expect(writeRecordPatterns(workflows.agents.get('executor')!).map(pattern=>pattern.source)).toEqual(template.name==='classic-git'?['status.md','git-correction.md']:['status.md']);
    expect(writeRecordPatterns(workflows.agents.get('reviewer')!).map(pattern=>pattern.source)).toEqual(['review.md','review-*.md']);
    expect(writeRecordPatterns(workflows.analyst).map(pattern=>pattern.source)).toEqual(['brief.md']);
    expect(writeRecordPatterns(workflows.oversight)).toEqual([]);
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
    expect(()=>resolveSystemTemplate('nope')).toThrow("Unknown template 'nope'. Available templates: classic, classic-typed, paad-typed, classic-git, newloop, newloop2.");
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
    const assessments=SYSTEM_TEMPLATES.filter(template=>template.name!=='newloop2').map(template=>{
       const workflow=compileProjectWorkflows(effectiveSaivageConfigSchema.parse(templateConfig(template)),{defaultPromptRoot:template.promptRoot}).cardTypes.get('project')!;
      const node=workflow.states.get('node:assess-completion')!;
      if(node.kind!=='node')throw new Error('Missing project assessment');
      return workflow.processPrompts.get(agentExecution(node).prompt.promptId)!.text;
    });
    expect(new Set(assessments).size).toBe(1);
  });

  it('reuses the complete frozen typed config with the same selected closure and only bounded prose deltas',()=>{
    const typed=resolveSystemTemplate('classic-typed');const paad=resolveSystemTemplate('paad-typed');
    expect(paad.config).toBe(typed.config);
    expect(Object.isFrozen(paad.config)).toBe(true);
    expect(collectTemplatePromptClosure({template:paad})).toEqual(collectTemplatePromptClosure({template:typed}));
    expect(()=>assertPaadTypedPromptParity()).not.toThrow();
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
    expect(first.agents.oversight!.capabilities).not.toBe(second.agents.oversight!.capabilities);
    expect(first.agents.oversight!.capabilities.grants.flatMap((grant)=>grant.tools)).toEqual(OVERSIGHT_ALLOWED_TOOL_NAMES);
    expect(first.card_types).toBe(firstGraph);
    expect(Object.isFrozen(firstGraph.project!.workflow.nodes)).toBe(true);
    expect(Object.isFrozen(first.agents.analyst!.capabilities)).toBe(true);
    expect(Object.isFrozen(first.models.routes)).toBe(true);
  });

  it('keeps newloop on the identical deeply frozen typed config and exact eight-delta closure',()=>{
    const typed=resolveSystemTemplate('classic-typed');const newloop=resolveSystemTemplate('newloop');
    expect(newloop.config).toBe(typed.config);
    expect(Object.isFrozen(newloop.config.card_types!.project!.workflow.nodes)).toBe(true);
    expect(Object.isFrozen(newloop.config.agents)).toBe(true);
    expect(collectTemplatePromptClosure({template:newloop})).toEqual(collectTemplatePromptClosure({template:typed}));
    expect(()=>assertNewloopPromptParity()).not.toThrow();
  });

  it('compiles each selected Executor with its observed guidance closure and one rendered outcome contract',()=>{
    for(const {name:templateName} of SYSTEM_TEMPLATES){
      const template=resolveSystemTemplate(templateName);const observed:string[]=[];
      const workflows=compileProjectWorkflows(effectiveSaivageConfigSchema.parse(templateConfig(template)),{defaultPromptRoot:template.promptRoot,artifactObserver:(artifact)=>observed.push(artifact.path)});
      const rendered=createPromptTemplateRegistry(workflows).render({kind:'workflow-agent',cardType:'code'},'executor',{contractDescription:'UNIQUE-OUTCOME-CONTRACT'});
      expect(rendered.split('UNIQUE-OUTCOME-CONTRACT')).toHaveLength(2);
      expect(observed.some((path)=>path.endsWith('/agents/_shared/executor.md'))).toBe(true);
      expect(observed.some((path)=>path.endsWith('/fragments/_shared/project-guidance-common.md'))).toBe(true);
      expect(observed.some((path)=>path.endsWith('/fragments/_shared/project-guidance-executor.md'))).toBe(true);
    }
  });

  it('ships the global role include and vocabulary tokens',()=>{
    for(const {name:templateName} of SYSTEM_TEMPLATES){
      const analyst=readFileSync(join(resolveSystemTemplate(templateName).promptRoot,'agents/_shared/analyst.md'),'utf8');
      expect(analyst.match(/\{\{[^}]+\}\}/gu)).toEqual(['{{>operator-policy-overrides}}',...(templateName==='classic-git'?['{{>native-global}}']:[]),'{{>project-guidance-common}}','{{>project-guidance-analyst}}','{{vocabularySnippet}}']);
      const oversight=readFileSync(join(resolveSystemTemplate(templateName).promptRoot,'agents/_shared/oversight.md'),'utf8');
      expect(oversight.match(/\{\{[^}]+\}\}/gu)).toEqual(['{{>operator-policy-overrides}}',...(templateName==='classic-git'?['{{>native-global}}']:[]),'{{>project-guidance-common}}','{{>project-guidance-oversight}}','{{vocabularySnippet}}']);
    }
  });
});

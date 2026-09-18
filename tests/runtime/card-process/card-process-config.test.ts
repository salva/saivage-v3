import { afterEach,describe,expect,it } from '@jest/globals';
import { mkdirSync,mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_SAIVAGE_CONFIG,resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { EMIT_RESULT_SUMMARY_MAX_CHARS,bindRuntimeWorkflows,cardProcessEntryForStatus,compileProjectWorkflows,describeNodeResultContract,nodeResultSchema,nodeResultToolDefinition,processNodeOutcomes } from '../../../src/runtime/card-process/card-process-config.js';
import { effectiveSaivageConfigSchema,saivageConfigSchema,type SaivageConfig } from '../../../src/schemas/saivage-config.js';
import type { CardStatus } from '../../../src/schemas/index.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { formatVocabularySnippet } from '../../../src/agents/analyst-prompt.js';
import { createPromptTemplateRegistry, renderCompiledPrompt } from '../../../src/utils/prompt-api.js';
import { projectCompiledGraphs } from '../../../src/runtime/card-process/compiled-graphs-projection.js';
import { specializedCardTypes, specializedConfig } from '../../helpers/specialized-config.js';

function source():SaivageConfig{return effectiveSaivageConfigSchema.parse(structuredClone(DEFAULT_SAIVAGE_CONFIG));}
function failure(change:(value:SaivageConfig)=>void,message:RegExp):void{const value=source();change(value);expect(()=>compileProjectWorkflows(value)).toThrow(message);}
function compiledDeclaration(value:{reference:string;compactable?:boolean;compaction_key?:string}|undefined|null){return value?{promptId:value.reference,compactable:value.compactable??true,...(value.compaction_key===undefined?{}:{compactionKey:value.compaction_key})}:null;}
const roots:string[]=[];afterEach(()=>{while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('named-agent card-type workflow compilation',()=>{
  it('uses the terminal-result summary character limit in validation and generated text',()=>{
    const process=compileProjectWorkflows(source()).cardTypes.get('project')!;
    const [stateId]=[...process.states].find(([,candidate])=>candidate.kind==='node')!;
    const outcome=processNodeOutcomes(process,stateId)[0]!;
    expect(nodeResultSchema(process,stateId).safeParse({outcome,summary:'x'.repeat(EMIT_RESULT_SUMMARY_MAX_CHARS)}).success).toBe(true);
    expect(nodeResultSchema(process,stateId).safeParse({outcome,summary:'x'.repeat(EMIT_RESULT_SUMMARY_MAX_CHARS+1)}).success).toBe(false);
    expect(describeNodeResultContract(process,stateId)).toContain(`at most ${EMIT_RESULT_SUMMARY_MAX_CHARS} characters`);
  });
  it('compiles the classic template source and the derived default identically',()=>{
    const fromTemplate=compileProjectWorkflows(effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate('classic').config)));
    const derived=compileProjectWorkflows(source());
    expect(fromTemplate).toEqual(derived);
  });
  it('compiles and projects each consuming declaration policy without changing selected prompt text',()=>{
    const baseline=compileProjectWorkflows(source()).cardTypes.get('project')!;
    const config=source();
    config.agents.planner!.prompt={reference:'planner',compactable:false};
    config.agents.analyst!.prompt={reference:'analyst',compactable:false};
    const project=config.card_types.project!;
    project.workflow.nodes.plan!.prompt={reference:'plan',compactable:false};
    project.workflow.nodes.plan!.correction_prompt={reference:'correct-plan-result',compactable:false,compaction_key:' correction key '};
    project.workflow.entries.STOPPED.prompt={reference:'stopped-recovery',compactable:false,compaction_key:' entry key '};
    project.workflow.nodes.plan!.edges.admit_review!.prompt={reference:'plan-to-review',compactable:false,compaction_key:' edge key '};
    project.workflow.nodes.review!.edges.approved!.pending_notifications!.prompt={reference:'review-to-notifications',compactable:false,compaction_key:' notification key '};
    const compiled=compileProjectWorkflows(config);
    const workflow=compiled.cardTypes.get('project')!;
    const plan=workflow.states.get('node:plan')!;
    if(plan.kind!=='node')throw new Error('Missing compiled plan node.');
    expect(plan.agent.prompt).toEqual({reference:'planner',compactable:false});
    expect(plan.prompt).toEqual({promptId:'plan',compactable:false});
    expect(plan.correctionPrompt).toEqual({promptId:'correct-plan-result',compactable:false,compactionKey:' correction key '});
    expect(workflow.processPrompts.get(plan.prompt.promptId)?.text).toBe(baseline.processPrompts.get('plan' as never)?.text);
    config.providers={test:{models:['gpt-5.6'],capabilities:{contextWindowTokens:100_000,maxOutputTokens:10_000}}};
    const registry=new ProviderRegistry(config);
    const bound=bindRuntimeWorkflows(compiled,new ModelRouter(registry),registry,config.compaction.context_utilization_fraction);
    const graph=projectCompiledGraphs(bound).graphs.find(({card_type})=>card_type==='project')!;
    expect(projectCompiledGraphs(bound).global_agents.find(({agent_name})=>agent_name==='analyst')?.prompt.declaration).toEqual({reference:'analyst',compactable:false});
    expect(graph.nodes.find(({node_id})=>node_id==='plan')?.prompt).toMatchObject({
      declaration:{reference:'planner',compactable:false},
      process:{reference:'plan',compactable:false},
      correction:{reference:'correct-plan-result',compactable:false,compaction_key:' correction key '},
    });
    expect(graph.entries.find(({entry})=>entry==='STOPPED')?.prompt).toEqual({reference:'stopped-recovery',compactable:false,compaction_key:' entry key '});
    expect(graph.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({source_node_id:'plan',outcome:'admit_review',condition:'default',prompt:{reference:'plan-to-review',compactable:false,compaction_key:' edge key '}}),
      expect.objectContaining({source_node_id:'review',outcome:'approved',condition:'pending_notifications',prompt:{reference:'review-to-notifications',compactable:false,compaction_key:' notification key '}}),
    ]));
  });
  it('compiles exact selected globals and capability-derived planning targets',()=>{const compiled=compileProjectWorkflows(source());expect([...compiled.selectedGlobalParticipants.keys()]).toEqual(['analyst','oversight']);expect(compiled.oversight).toMatchObject({name:'oversight',session:'global',skills:false,canCreateChildren:false});expect(compiled.cardTypes.get('project')?.planningNotificationTarget).toBe(true);expect(compiled.cardTypes.get('code')?.planningNotificationTarget).toBe(false);expect(createPromptTemplateRegistry(compiled).render({kind:'global-agent'},'oversight',{vocabularySnippet:formatVocabularySnippet(compiled.cardTypeVocabulary)})).toContain('independently scheduled project-global observer');});
  it('rejects every invalid selected Oversight authority even while disabled',()=>{failure((value)=>{value.oversight.enabled=false;value.oversight.agent=value.analyst_agent;},/must differ/);failure((value)=>{value.oversight.enabled=false;value.agents.oversight!.session='card';value.agents.oversight!.tools=[];},/global session/);failure((value)=>{value.agents.oversight!.can_create_children=true;},/can_create_children/);failure((value)=>{value.agents.oversight!.record_writes=['status.md'];},/no record_writes/);failure((value)=>{value.agents.oversight!.skills=true;value.agents.oversight!.tools.push('skill');},/skills: false/);failure((value)=>{value.agents.oversight!.tools=['run_command'];},/forbidden/);});
  it('requires the complete Oversight section and validates its disabled route without provider I/O',()=>{
    const missing=structuredClone(DEFAULT_SAIVAGE_CONFIG) as Record<string,unknown>;delete missing.oversight;
    expect(()=>saivageConfigSchema.parse(missing)).toThrow();
    const config=source();config.oversight.enabled=false;delete config.models.routes.oversight;
    const registry=new ProviderRegistry(config);
    expect(()=>bindRuntimeWorkflows(compileProjectWorkflows(config),new ModelRouter(registry),registry,config.compaction.context_utilization_fraction)).toThrow(/route 'oversight'/i);
  });
  it('derives planning eligibility from custom recipient capabilities rather than role or type spelling',()=>{
    const config=source();
    config.agents.strategist={...config.agents.planner!,model_route:'planner'};
    delete config.agents.planner;
    for(const cardType of Object.values(config.card_types)){
      if(cardType.workflow.notification_recipient==='planner')cardType.workflow.notification_recipient='strategist';
      for(const node of Object.values(cardType.workflow.nodes))if(node.agent==='planner')node.agent='strategist';
    }
    const custom=structuredClone(config.card_types.goal!);custom.permitted_child_types=[];config.card_types.project!.permitted_child_types=['strategy-scope'];config.card_types={'project':config.card_types.project!,'strategy-scope':custom};
    const compiled=compileProjectWorkflows(config);
    expect(compiled.cardTypes.get('project')).toMatchObject({notificationRecipient:'strategist',planningNotificationTarget:true});
    expect(compiled.cardTypes.get('strategy-scope')).toMatchObject({notificationRecipient:'strategist',planningNotificationTarget:false});
  });
  it('compiles the exact complete specialized set with only defined roles and compiler-owned runtime edges',()=>{
    const expected=specializedCardTypes();
    const config=specializedConfig();
    const compiled=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});
    expect([...compiled.cardTypes.keys()]).toEqual(Object.keys(expected));
    const roles=new Set<string>();
    for(const [cardType,expectedCardType] of Object.entries(expected)){
      const workflow=compiled.cardTypes.get(cardType as never)!;
      expect(workflow.notificationRecipient).toBe(expectedCardType.workflow.notification_recipient);
      expect([...workflow.permittedChildTypes]).toEqual(expectedCardType.permitted_child_types);
      expect([...workflow.records.values()].map(({name,format,schema,bootstrap})=>({name,format,schema,bootstrap}))).toEqual(Object.entries(expectedCardType.records).map(([name,record])=>({name,...record})));
      for(const [entry,expectedEntry] of Object.entries(expectedCardType.workflow.entries)){
        const route=workflow.states.get(`entry:${entry}`)!.on.get('entry:route')!;
        expect(route).toMatchObject({targetStateId:`node:${expectedEntry.node}`,reenter:false,semantic:{kind:'entry-route',prompt:compiledDeclaration(expectedEntry.prompt)}});
      }
      for(const [nodeId,expectedNode] of Object.entries(expectedCardType.workflow.nodes)){
        const state=workflow.states.get(`node:${nodeId}`)!;if(state.kind!=='node')throw new Error(`missing ${cardType}/${nodeId}`);
        roles.add(state.agent.name);
        expect({agent:state.agent.name,prompt:state.prompt,correction:state.correctionPrompt,requirements:state.requirements.map(({definition,mode,gate})=>[definition.name,mode,gate]),descendant:state.descendantContext&&{records:state.descendantContext.records.map(({name})=>name),require_unchanged_until_accept:state.descendantContext.requireUnchangedUntilAccept}}).toEqual({agent:expectedNode.agent,prompt:compiledDeclaration(expectedNode.prompt),correction:compiledDeclaration(expectedNode.correction_prompt),requirements:Object.entries(expectedNode.records??{}).map(([name,{mode,gate}])=>[name,mode,gate]),descendant:expectedNode.descendant_context?{records:expectedNode.descendant_context.records,require_unchanged_until_accept:expectedNode.descendant_context.require_unchanged_until_accept}:null});
        for(const [outcome,expectedEdge] of Object.entries(expectedNode.edges)){
          const route=state.on.get(`result:${outcome}`)!;
          expect(route.semantic).toMatchObject({kind:'configured-outcome',outcome,prompt:compiledDeclaration(expectedEdge.prompt)});
          if('node' in expectedEdge.target){expect(route).toMatchObject({targetStateId:`node:${expectedEdge.target.node}`,reenter:expectedEdge.target.node===nodeId});}
          else {expect(route.targetStateId).toBe(`terminal:${expectedEdge.target.terminal}`);if(route.semantic.kind!=='configured-outcome'||!route.semantic.terminalBehavior)throw new Error('missing terminal behavior');expect(route.semantic.terminalBehavior).toEqual({promotion:expectedEdge.target.promote==='current'?{kind:'current'}:{kind:'latest-node',nodeId:expectedEdge.target.promote.latest_node},exportRecords:expectedEdge.target.export_records.map((name)=>workflow.records.get(name)!)});}
          if(expectedEdge.pending_notifications)expect(state.on.get(`result:${outcome}:pending-notifications`)).toEqual({targetStateId:`node:${expectedEdge.pending_notifications.node}`,reenter:expectedEdge.pending_notifications.node===nodeId,semantic:{kind:'configured-pending-notifications',outcome,prompt:compiledDeclaration(expectedEdge.pending_notifications.prompt)}});
        }
        expect([...state.on.keys()]).toEqual([...Object.entries(expectedNode.edges).flatMap(([outcome,edge])=>[`result:${outcome}`,...(edge.pending_notifications?[`result:${outcome}:pending-notifications`]:[])]),'execution:failed','execution:blocked']);
        expect(state.on.get('execution:failed')!.semantic).toEqual({kind:'runtime-terminal',cause:'failed'});
        expect(state.on.get('execution:blocked')!.semantic).toEqual({kind:'runtime-terminal',cause:'blocked'});
      }
    }
    expect(roles).toEqual(new Set(['planner','reviewer','executor']));
    const sources=Object.values(expected);const nodes=sources.flatMap(({workflow})=>Object.keys(workflow.nodes));const references=sources.flatMap(({workflow})=>[...Object.values(workflow.entries).flatMap(({node,prompt})=>[node,...(prompt?[prompt.reference]:[])]),...Object.values(workflow.nodes).flatMap((node)=>[node.prompt.reference,node.correction_prompt.reference,...Object.values(node.edges).flatMap(({target,prompt,pending_notifications})=>[...('node'in target?[target.node]:[]),...('terminal'in target&&target.promote!=='current'?[target.promote.latest_node]:[]),...(prompt?[prompt.reference]:[]),...(pending_notifications?[pending_notifications.node,pending_notifications.prompt.reference]:[])])])]);const outcomes=sources.flatMap(({workflow})=>Object.values(workflow.nodes).flatMap(({edges})=>Object.keys(edges)));
    expect([...new Set(nodes)]).toEqual(['plan','review','recover','handle-notifications','draft','component-review','system-review','red','green','refactor','diagnose','add-coverage','repair','verify','execute','schema','validate','implement','explore','assess','report']);
    expect([...new Set(outcomes)]).toEqual(['complete_direct','admit_review','blocked','failed','approved','revision_required','ready_for_component_review','red_confirmed','already_green','green','still_red','done','regressed','coverage_ready','coverage_gap','failing_test','coverage_passing','repair_needed','tests_passing','still_failing','schema_ready','valid','schema_invalid','implementation_retry','schema_revision','evidence_ready','more_exploration','supported','refuted','bounded_inconclusive','evidence_gap']);
    expect(references.every((id)=>/^[a-z][a-z0-9-]{0,63}$/u.test(id))).toBe(true);expect(outcomes.every((id)=>/^[a-z][a-z0-9_-]{0,63}$/u.test(id))).toBe(true);
  });

  it('compiles the exact typed test graph and derives its ready contract from the configured edge',()=>{
    const process=compileProjectWorkflows(specializedConfig(),{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot}).cardTypes.get('test')!;
    const expectedEntries={BACKLOG:{node:'diagnose',prompt:null},CHANGED:{node:'diagnose',prompt:null},BLOCKED:{node:'diagnose',prompt:null},STOPPED:{node:'diagnose',prompt:'stopped-recovery'}} as const;
    for(const [entry,expected] of Object.entries(expectedEntries))expect(process.states.get(`entry:${entry}`)!.on.get('entry:route')).toMatchObject({targetStateId:`node:${expected.node}`,semantic:{kind:'entry-route',prompt:expected.prompt===null?null:{promptId:expected.prompt,compactable:true}}});
    const expectedNodes={
      diagnose:{prompt:'test-diagnose',outcomes:[['coverage_ready','verify','test-to-verify'],['coverage_gap','add-coverage','test-to-add-coverage'],['failing_test','repair','test-to-repair'],['blocked','BLOCKED',null],['failed','FAILED',null]]},
      'add-coverage':{prompt:'test-add-coverage',outcomes:[['coverage_passing','verify','test-to-verify'],['repair_needed','repair','test-to-repair'],['blocked','BLOCKED',null],['failed','FAILED',null]]},
      repair:{prompt:'test-repair',outcomes:[['tests_passing','verify','test-to-verify'],['still_failing','repair','test-repair-retry'],['blocked','BLOCKED',null],['failed','FAILED',null]]},
      verify:{prompt:'test-verify',outcomes:[['done','DONE',null],['coverage_gap','add-coverage','test-to-add-coverage'],['repair_needed','repair','test-to-repair'],['blocked','BLOCKED',null],['failed','FAILED',null]]},
    } as const;
    for(const [nodeId,expected] of Object.entries(expectedNodes)){
      const state=process.states.get(`node:${nodeId}`)!;if(state.kind!=='node')throw new Error(`missing test/${nodeId}`);
      expect(state.prompt.promptId).toBe(expected.prompt);expect(state.requirements.map(({definition,mode,gate})=>[definition.name,mode,gate])).toEqual([['status.md','continue','updated']]);
      expect(processNodeOutcomes(process,`node:${nodeId}`)).toEqual(expected.outcomes.map(([outcome])=>outcome));
      for(const [outcome,target,promptId] of expected.outcomes){const edge=state.on.get(`result:${outcome}`)!;expect(edge.semantic).toMatchObject({kind:'configured-outcome',outcome,prompt:promptId===null?null:{promptId,compactable:true}});expect(edge.targetStateId).toBe(target==='DONE'||target==='BLOCKED'||target==='FAILED'?`terminal:${target}`:`node:${target}`);}
    }
    const diagnoseOutcomes=expectedNodes.diagnose.outcomes.map(([outcome])=>outcome);
    expect(nodeResultSchema(process,'node:diagnose').safeParse({outcome:'coverage_ready',summary:'Adequate meaningful coverage passes.'}).success).toBe(true);
    expect(nodeResultSchema(process,'node:diagnose').safeParse({outcome:'done',summary:'Bypass verification.'}).success).toBe(false);
    expect(nodeResultSchema(process,'node:verify').safeParse({outcome:'coverage_ready',summary:'Wrong node.'}).success).toBe(false);
    expect(describeNodeResultContract(process,'node:diagnose')).toContain(`outcome (one of: ${diagnoseOutcomes.join(' | ')})`);
    expect(nodeResultToolDefinition(process,'node:diagnose').function.parameters).toMatchObject({type:'object',properties:{outcome:{type:'string',enum:diagnoseOutcomes}},required:['outcome','summary'],additionalProperties:false});
    expect(process.processPrompts.get('test-diagnose' as never)?.text).toBe('Run or inspect the focused target and determine whether the accepted brief already has meaningful adequate coverage with passing tests, identifies missing coverage, or exposes an actually failing test or fixture. A fresh or resumed diagnosis may truthfully require no test or source change; do not manufacture a failure or metadata delta for behavior that is already correct. Update `record:///status.md?card=<card-id>` with the target, commands, observations, classification, and current status. Select `coverage_ready` only when meaningful coverage is adequate for the accepted brief and the focused tests pass, `coverage_gap` for absent meaningful coverage, `failing_test` for an observed failing test or fixture, `blocked` when diagnosis needs unavailable input, or `failed` for a conclusive failure.\n');
    expect(process.processPrompts.get('test-to-verify' as never)?.text).toBe("The focused tests pass, whether already passing at diagnosis or after coverage or repair work. Verify the affected suite and the coverage's meaning, stability, and scope before completion.\n");
  });

  it('rejects underscore-bearing workflow node keys without widening or normalization',()=>{
    const config=specializedConfig();
    const node=config.card_types.test!.workflow.nodes['add-coverage']!;
    config.card_types.test!.workflow.nodes['add_coverage']=node;
    delete config.card_types.test!.workflow.nodes['add-coverage'];
    expect(()=>compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot})).toThrow(/workflow\.nodes key must be a lowercase identifier/);
  });
  it('treats a configured global card type as card-scoped for agents, fragments, processes, and registry rendering',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'workflow-global-card-'));roots.push(projectRoot);
    const config=source();
    config.card_types.project!.permitted_child_types=['global'];
    config.card_types={project:config.card_types.project!,global:structuredClone(config.card_types.code!)};
    const promptRoot=join(projectRoot,'.saivage','config','prompts');
    const write=(purpose:string,scope:string,id:string,text:string)=>{const dir=join(promptRoot,purpose,scope);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${id}.md`),text);};
    write('agents','global','executor','GLOBAL CARD {{> scope-fragment}} {{contractDescription}}');
    write('fragments','global','scope-fragment','CARD FRAGMENT');
    write('process','global','execute','GLOBAL PROCESS {{cardType}}');
    const compiled=compileProjectWorkflows(config,{projectRoot});
    expect(compiled.cardTypeVocabulary).toEqual(['project','global']);
    const workflow=compiled.cardTypes.get('global')!;const node=workflow.states.get('node:execute')!;if(node.kind!=='node')throw new Error('missing global execute node');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'global'},node.agent.name,node.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toBe('GLOBAL CARD CARD FRAGMENT contract');
    expect(workflow.processPrompts.get('execute' as never)?.text).toBe('GLOBAL PROCESS global');
    const registry=createPromptTemplateRegistry(compiled);
    expect(registry.render({kind:'workflow-agent',cardType:'global'},'executor',{contractDescription:'contract'})).toBe('GLOBAL CARD CARD FRAGMENT contract');
    expect(registry.render({kind:'global-agent'},'analyst',{vocabularySnippet:'types'})).toContain('Saivage Analyst');
    expect(registry.render({kind:'global-agent'},'oversight',{vocabularySnippet:'custom vocabulary'})).toContain('custom vocabulary');
  });
  it('projects exactly configured graphs and the same effective leaf tool selection used by execution',()=>{
    const config=source();config.providers={test:{models:['gpt-5.6'],capabilities:{contextWindowTokens:100_000,maxOutputTokens:10_000}}};
    const project=structuredClone(config.card_types.project!);project.permitted_child_types=['leaf-plan'];
    const leaf=structuredClone(config.card_types.goal!);leaf.permitted_child_types=[];
    config.card_types={project,'leaf-plan':leaf};
    const registry=new ProviderRegistry(config);const bound=bindRuntimeWorkflows(compileProjectWorkflows(config),new ModelRouter(registry),registry,config.compaction.context_utilization_fraction);
    const graphs=projectCompiledGraphs(bound).graphs;
    expect(graphs.map((graph)=>graph.card_type)).toEqual(['project','leaf-plan']);
    const projectPlan=graphs[0]!.nodes.find((node)=>node.node_id==='plan')!;
    const leafPlan=graphs[1]!.nodes.find((node)=>node.node_id==='plan')!;
    expect(projectPlan.tools).toContain('create_card');
    expect(leafPlan.tools).not.toContain('create_card');
    const leafState=bound.cardTypes.get('leaf-plan')!.states.get('node:plan')!;if(leafState.kind!=='node')throw new Error('missing leaf plan node');
    expect(leafPlan.tools).toEqual(leafState.agent.tools.filter((tool)=>tool.name!=='create_card').map((tool)=>tool.name));
  });
  it.each([
    ['backlog','BACKLOG'],['running',null],['blocked','BLOCKED'],['changed','CHANGED'],['stopped','STOPPED'],['done',null],['failed',null],['cancelled',null],
  ] satisfies Array<[CardStatus,'BACKLOG'|'CHANGED'|'BLOCKED'|'STOPPED'|null]>)('maps %s to its workflow entry',(status,entry)=>expect(cardProcessEntryForStatus(status)).toBe(entry));

  it('publishes one deeply immutable state table in exact source order',()=>{
    const compiled = compileProjectWorkflows(source());
    expect([...compiled.cardTypes.keys()]).toEqual([
      'project','goal','architecture','code','test','doc','data','research','ops',
    ]);
    const goal = compiled.cardTypes.get('goal')!;
    expect([...goal.states.keys()]).toEqual([
      'lifecycle:ready',
      'entry:BACKLOG',
      'entry:CHANGED',
      'entry:BLOCKED',
      'entry:STOPPED',
      'node:plan',
      'node:review',
      'node:recover',
      'node:handle-notifications',
      'terminal:DONE',
      'terminal:BLOCKED',
      'terminal:FAILED',
    ]);
    expect([...goal.states.get('lifecycle:ready')!.on.keys()]).toEqual([
      'activate:BACKLOG',
      'activate:CHANGED',
      'activate:BLOCKED',
      'activate:STOPPED',
    ]);
    const plan = goal.states.get('node:plan')!;
    expect(plan.kind).toBe('node');
    if(plan.kind!=='node') throw new Error('missing plan node');
    expect([...plan.on.keys()]).toEqual([
      'result:complete_direct',
      'result:admit_review',
      'result:blocked',
      'result:failed',
      'execution:failed',
      'execution:blocked',
    ]);
    expect(plan.agent.name).toBe('planner');
    expect([...plan.childCreationTypes]).toContain('code');
    expect(goal.records.get('brief.md')!.bootstrap).toBe(true);
    const activation = goal.states.get('lifecycle:ready')!.on.get('activate:BACKLOG')!;
    expect(activation.semantic).toEqual({kind:'activation'});
    expect(goal.states.get(activation.targetStateId)).toMatchObject({
      kind:'entry',entry:'BACKLOG',
    });
    const entryRoute = goal.states.get(activation.targetStateId)!.on.get('entry:route')!;
    expect(entryRoute.semantic).toEqual({kind:'entry-route',prompt:null});
    expect(goal.states.get(entryRoute.targetStateId)).toBe(plan);
    const admitReview = plan.on.get('result:admit_review')!;
    expect(admitReview.semantic).toEqual({
      kind:'configured-outcome',
      outcome:'admit_review',
      prompt:{promptId:'plan-to-review',compactable:true},
      terminalBehavior:null,
    });
    expect(goal.states.get(admitReview.targetStateId)).toBe(goal.states.get('node:review'));
    const complete = plan.on.get('result:complete_direct')!;
    expect(goal.states.get(complete.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'DONE',isTerminal:true,isParked:false,
    });
    if (complete.semantic.kind !== 'configured-outcome' || !complete.semantic.terminalBehavior)
      throw new Error('missing configured terminal behavior');
    expect(complete.semantic.terminalBehavior.promotion).toEqual({kind:'current'});
    expect(complete.semantic.terminalBehavior.exportRecords.map((record)=>record.name)).toEqual([
      'status.md',
    ]);
    expect(Object.isFrozen(complete.semantic.terminalBehavior)).toBe(true);
    expect(Object.isFrozen(complete.semantic.terminalBehavior.promotion)).toBe(true);
    expect(Object.isFrozen(complete.semantic.terminalBehavior.exportRecords)).toBe(true);
    const runtimeFailed = plan.on.get('execution:failed')!;
    expect(runtimeFailed.semantic).toEqual({kind:'runtime-terminal',cause:'failed'});
    expect(goal.states.get(runtimeFailed.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'FAILED',
    });

    const review = goal.states.get('node:review')!;
    if (review.kind !== 'node' || !review.descendantContext)
      throw new Error('missing review node descendant context');
    expect(Object.isFrozen(review.requirements)).toBe(true);
    expect(Object.isFrozen(review.descendantContext)).toBe(true);
    expect(Object.isFrozen(review.descendantContext.records)).toBe(true);
    expect(Object.isFrozen(plan.agent.tools)).toBe(true);
    expect(Object.isFrozen(plan.agent.model)).toBe(true);
    expect(Object.isFrozen(plan.agent.model.orderedModelIds)).toBe(true);

    for (const state of goal.states.values()) {
      expect(Object.isFrozen(state)).toBe(true);
      expect(Object.isFrozen(state.on)).toBe(true);
      if (state.kind === 'terminal') {
        expect(state.on.size).toBe(0);
        expect(state.isTerminal).toBe(true);
        expect(state.isParked).toBe(false);
      }
      for (const transition of state.on.values()) {
        expect(Object.keys(transition)).toEqual(['targetStateId','reenter','semantic']);
        expect(Object.isFrozen(transition)).toBe(true);
        expect(Object.isFrozen(transition.semantic)).toBe(true);
        if (transition.semantic.kind === 'activation') {
          expect(Object.keys(transition.semantic)).toEqual(['kind']);
        } else if (transition.semantic.kind === 'entry-route') {
          expect(Object.keys(transition.semantic)).toEqual(['kind','prompt']);
        } else if (transition.semantic.kind === 'runtime-terminal') {
          expect(Object.keys(transition.semantic)).toEqual(['kind','cause']);
        } else if (transition.semantic.kind === 'configured-pending-notifications') {
          expect(Object.keys(transition.semantic)).toEqual(['kind','outcome','prompt']);
        } else {
          expect(Object.keys(transition.semantic)).toEqual([
            'kind','outcome','prompt','terminalBehavior',
          ]);
        }
        expect(goal.states.has(transition.targetStateId)).toBe(true);
      }
    }
    expect(Object.isFrozen(goal.states)).toBe(true);
    expect(Object.isFrozen(goal.processPrompts)).toBe(true);
    expect((goal.states as Map<unknown,unknown>).set).toBeUndefined();
    expect((plan.on as Map<unknown,unknown>).set).toBeUndefined();
    expect((goal.processPrompts as Map<unknown,unknown>).set).toBeUndefined();
    expect(goal).not.toHaveProperty('definition');
    expect(goal).not.toHaveProperty('nodes');
    expect(goal).not.toHaveProperty('transitionPrompts');
    expect(plan).not.toHaveProperty('edges');
    expect(plan).not.toHaveProperty('outcomes');
    expect(plan).not.toHaveProperty('nodePrompt');
    expect(plan).not.toHaveProperty('correctionPromptText');
    expect((compiled.cardTypes as Map<unknown,unknown>).set).toBeUndefined();
    expect(compiled.cardTypes.get('project')).not.toBe(compiled.cardTypes.get('goal'));
    for(const type of ['architecture','code','test','doc','data','research','ops'] as const)expect(compiled.cardTypes.get(type)?.states.get('node:execute')).toMatchObject({kind:'node',nodeId:'execute'});
    expect(compiled.agents.get('planner')?.tools.map((tool)=>tool.name)).toEqual(['create_card','edit_card','cancel_card','activate_card','reopen_card','reorder_child','queue_notification','list_cards','get_card','get_tree','read','write','edit','glob','grep','list_card_versions','get_card_version','diff_card_versions','read_record_version','websearch','webfetch']);
    expect(compiled.agents.get('reviewer')?.tools.map((tool)=>tool.name)).not.toContain('mcp_tool_call');
    expect(compiled.agents.get('executor')?.tools.map((tool)=>tool.name)).toContain('mcp_tool_call');
    expect(compiled.agents.get('analyst')?.tools).toHaveLength(43);
    expect(compiled.agents.get('analyst')?.tools[2]?.name).toBe('reopen_card');
  });

  it('keeps agent, node, and correction prompt snapshots under their compiled owners',()=>{
    const projectRoot=mkdtempSync(join(tmpdir(),'workflow-prompts-'));
    roots.push(projectRoot);
    const path=join(projectRoot,'.saivage','config','prompts','agents','code');
    mkdirSync(path,{recursive:true});
    const override='UNIQUE EXECUTOR OVERRIDE {{contractDescription}}';
    writeFileSync(join(path,'executor.md'),override);
    const processPath=join(projectRoot,'.saivage','config','prompts','process','code');
    mkdirSync(processPath,{recursive:true});
    writeFileSync(join(processPath,'execute.md'),'Selected node prompt');
    writeFileSync(join(processPath,'correct-execution-result.md'),'Selected correction prompt');
    const compiled=compileProjectWorkflows(source(),{projectRoot});
    const process=compiled.cardTypes.get('code')!;
    const node=process.states.get('node:execute')!;
    if(node.kind!=='node') throw new Error('missing execute node');
    expect(node.selectedAgentPrompt).toMatchObject({source:'override-card'});
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},node.agent.name,node.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toBe('UNIQUE EXECUTOR OVERRIDE contract');
    const cardRunCommand=node.agent.tools.find((tool)=>tool.name==='run_command');
    const analystRunCommand=compiled.agents.get('analyst')!.tools.find((tool)=>tool.name==='run_command');
    expect(cardRunCommand?.description).toContain('For a card-scoped run_command');
    expect(cardRunCommand?.description).toContain('SAIVAGE_CARD_WORK_ROOT is supplied');
    expect(cardRunCommand?.description).toContain('disposable copies');
    expect(cardRunCommand?.description).toContain('purpose-named child');
    expect(cardRunCommand?.description).toContain('.card-*-work sibling');
    expect(cardRunCommand?.description).toContain('reserved processes/ or tmp/ children');
    expect(analystRunCommand?.description).toContain('A global/non-card run_command does not supply SAIVAGE_CARD_WORK_ROOT and must not use it.');
    expect(cardRunCommand?.description).toBe(analystRunCommand?.description);
    expect(node.prompt).toEqual({promptId:'execute',compactable:true});
    expect(node.correctionPrompt).toEqual({promptId:'correct-execution-result',compactable:true});
    expect(process.processPrompts.get(node.prompt.promptId)).toMatchObject({
      source:'override-card',text:'Selected node prompt',
    });
    expect(process.processPrompts.get(node.correctionPrompt.promptId)).toMatchObject({
      source:'override-card',text:'Selected correction prompt',
    });
    expect(Object.isFrozen(process.processPrompts.get(node.prompt.promptId))).toBe(true);
    expect(Object.isFrozen(process.processPrompts.get(node.correctionPrompt.promptId))).toBe(true);
    expect(node).not.toHaveProperty('nodePrompt');
    expect(node).not.toHaveProperty('correctionPromptText');
    writeFileSync(join(path,'executor.md'),'changed after compile');
    writeFileSync(join(processPath,'execute.md'),'changed node after compile');
    writeFileSync(join(processPath,'correct-execution-result.md'),'changed correction after compile');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},node.agent.name,node.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toBe('UNIQUE EXECUTOR OVERRIDE contract');
    expect(process.processPrompts.get(node.prompt.promptId)!.text).toBe('Selected node prompt');
    expect(process.processPrompts.get(node.correctionPrompt.promptId)!.text).toBe(
      'Selected correction prompt',
    );
  });

  it('uses reference-keyed root-major selection and host-card fragment precedence',()=>{
    const root=mkdtempSync(join(tmpdir(),'workflow-precedence-'));roots.push(root);
    const defaults=join(root,'defaults');const overrides=join(root,'.saivage','config','prompts');
    const write=(base:string,purpose:string,scope:string,id:string,text:string)=>{const dir=join(base,purpose,scope);mkdirSync(dir,{recursive:true});writeFileSync(join(dir,`${id}.md`),text);};
    for(const id of ['analyst','oversight','planner','reviewer','executor'])write(defaults,'agents','_shared',id,id==='analyst'?'{{vocabularySnippet}}':id==='oversight'?'{{> oversight-vocabulary}}':`${id} {{contractDescription}}`);
    for(const id of ['plan','recover','review','handle-notifications','correct-plan-result','correct-review-result','plan-to-review','review-to-plan','review-to-notifications','execute','correct-execution-result','stopped-recovery'])write(defaults,'process','_shared',id,`${id} {{cardType}}`);
    write(defaults,'agents','code','executor','bundled-card {{contractDescription}}');
    write(overrides,'agents','_shared','executor','override-shared {{> shared-piece}} {{contractDescription}}');
    write(defaults,'fragments','_shared','shared-piece','bundled-fragment');
    write(defaults,'fragments','_shared','oversight-vocabulary','oversight {{vocabularySnippet}}');
    write(overrides,'fragments','code','shared-piece','override-code-fragment');
    write(defaults,'process','code','execute','bundled-card-process {{cardType}}');
    write(overrides,'process','_shared','execute','override-shared-process {{cardType}}');
    const value=source();value.agents.executor!.prompt={reference:'executor',compactable:true};value.agents.reviewer!.prompt={reference:'executor',compactable:true};
    const observations:Array<{source:string;path:string}>=[];
    const compiled=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root,artifactObserver:(artifact)=>observations.push(artifact)});
    expect(renderCompiledPrompt({kind:'global-agent'},compiled.oversight.name,compiled.oversightPrompt.compiled,{vocabularySnippet:'custom types'})).toBe('oversight custom types');
    const code=compiled.cardTypes.get('code')!;const node=code.states.get('node:execute')!;if(node.kind!=='node')throw new Error('missing node');
    expect(node.selectedAgentPrompt.source).toBe('override-shared');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},node.agent.name,node.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toBe('override-shared override-code-fragment contract');
    expect(code.processPrompts.get('execute' as never)).toMatchObject({source:'override-shared',text:'override-shared-process code'});
    expect(observations).toEqual(expect.arrayContaining([
      expect.objectContaining({source:'override-shared',path:join(overrides,'agents','_shared','executor.md')}),
      expect.objectContaining({source:'override-card',path:join(overrides,'fragments','code','shared-piece.md')}),
      expect.objectContaining({source:'override-shared',path:join(overrides,'process','_shared','execute.md')}),
    ]));
    const review=compiled.cardTypes.get('goal')!.states.get('node:review')!;if(review.kind!=='node')throw new Error('missing review');
    expect(review.selectedAgentPrompt.reference).toBe('executor');
    expect(review.selectedAgentPrompt.source).toBe('override-shared');
    value.card_types.code!.workflow.nodes.verify=structuredClone(value.card_types.code!.workflow.nodes.execute!);
    value.card_types.code!.workflow.nodes.execute!.edges.done={target:{node:'verify'},prompt:{reference:'execute',compactable:true}};
    value.card_types.code!.workflow.nodes.verify!.edges.done={target:{terminal:'DONE',promote:'current',export_records:['status.md']}};
    const shared=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root}).cardTypes.get('code')!;
    const executeNode=shared.states.get('node:execute')!;const verifyNode=shared.states.get('node:verify')!;
    if(executeNode.kind!=='node'||verifyNode.kind!=='node')throw new Error('missing shared-reference nodes');
    expect(verifyNode.selectedAgentPrompt).toBe(executeNode.selectedAgentPrompt);
    delete value.card_types.code!.workflow.nodes.verify;
    value.card_types.code!.workflow.nodes.execute!.edges.done={target:{terminal:'DONE',promote:'current',export_records:['status.md']}};
    expect(compiled.analystPrompt.source).toBe('bundled-shared');

    write(overrides,'agents','code','executor','override-card {{contractDescription}}');
    write(overrides,'process','code','execute','override-card-process {{cardType}}');
    let selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    let selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(selectedNode.selectedAgentPrompt.source).toBe('override-card');
    expect(selected.cardTypes.get('code')!.processPrompts.get('execute' as never)?.source).toBe('override-card');

    rmSync(join(overrides,'agents','code','executor.md'));rmSync(join(overrides,'agents','_shared','executor.md'));
    rmSync(join(overrides,'process','code','execute.md'));rmSync(join(overrides,'process','_shared','execute.md'));
    selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(selectedNode.selectedAgentPrompt.source).toBe('bundled-card');
    expect(selected.cardTypes.get('code')!.processPrompts.get('execute' as never)?.source).toBe('bundled-card');

    rmSync(join(defaults,'agents','code','executor.md'));rmSync(join(defaults,'process','code','execute.md'));
    selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(selectedNode.selectedAgentPrompt.source).toBe('bundled-shared');
    expect(selected.cardTypes.get('code')!.processPrompts.get('execute' as never)?.source).toBe('bundled-shared');

    write(defaults,'agents','code','executor','host {{> shared-piece}} {{contractDescription}}');
    write(defaults,'fragments','code','shared-piece','bundled-code-fragment');
    rmSync(join(overrides,'fragments','code','shared-piece.md'));
    selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},selectedNode.agent.name,selectedNode.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toContain('bundled-code-fragment');
    write(overrides,'fragments','_shared','shared-piece','override-shared-fragment');
    selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},selectedNode.agent.name,selectedNode.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toContain('override-shared-fragment');
    rmSync(join(overrides,'fragments','_shared','shared-piece.md'));rmSync(join(defaults,'fragments','code','shared-piece.md'));
    selected=compileProjectWorkflows(value,{defaultPromptRoot:defaults,projectRoot:root});
    selectedNode=selected.cardTypes.get('code')!.states.get('node:execute')!;if(selectedNode.kind!=='node')throw new Error('missing node');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'code'},selectedNode.agent.name,selectedNode.selectedAgentPrompt.compiled,{contractDescription:'contract'})).toContain('bundled-fragment');
  });

  it('renders every default process prompt eagerly and preserves corrected agent guidance',()=>{
    const compiled=compileProjectWorkflows(source());
    const stopped='Execution was stopped and its in-memory process position was discarded. Reconstruct no prior node; continue only from current durable evidence and context, not a guessed prior node.\n';
    for(const[cardType,workflow]of compiled.cardTypes){
      for(const prompt of workflow.processPrompts.values())expect(prompt.text).not.toMatch(/\{\{[^}]+\}\}/u);
      expect(workflow.processPrompts.get('stopped-recovery' as never)?.text).toBe(stopped);
      for(const state of workflow.states.values())if(state.kind==='node'){
        const rendered=renderCompiledPrompt({kind:'workflow-agent',cardType},state.agent.name,state.selectedAgentPrompt.compiled,{contractDescription:'GENERATED CONTRACT'});
        expect(rendered.match(/GENERATED CONTRACT/gu)).toHaveLength(1);
        expect(rendered).not.toMatch(/\{\{[^}]+\}\}/u);
      }
    }
    expect(compiled.cardTypes.get('doc')!.processPrompts.get('execute' as never)?.text).toContain('`doc`');
    expect(compiled.cardTypes.get('ops')!.processPrompts.get('execute' as never)?.text).toContain('`ops`');
    const goal=compiled.cardTypes.get('goal')!;
    const plan=goal.states.get('node:plan')!;const review=goal.states.get('node:review')!;
    if(plan.kind!=='node'||review.kind!=='node')throw new Error('missing goal nodes');
    const variables={contractDescription:'contract'};
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'goal'},plan.agent.name,plan.selectedAgentPrompt.compiled,variables)).not.toContain('canonical project card');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'goal'},review.agent.name,review.selectedAgentPrompt.compiled,variables)).not.toContain('project/root tree');
    const executor=compiled.cardTypes.get('doc')!.states.get('node:execute')!;if(executor.kind!=='node')throw new Error('missing executor');
    const executorText=renderCompiledPrompt({kind:'workflow-agent',cardType:'doc'},executor.agent.name,executor.selectedAgentPrompt.compiled,variables);
    expect(executorText).not.toContain('code card');
    expect(executorText).toContain('Reference cards durably as `[[card:<id>]]` in operator-facing Markdown.');
    expect(renderCompiledPrompt({kind:'workflow-agent',cardType:'goal'},review.agent.name,review.selectedAgentPrompt.compiled,variables)).toContain('Reference cards durably as `[[card:<id>]]`; do not rely on friendly display paths.');
  });

  it('fails rather than falling through when an exact prompt candidate is present but unreadable as a file',()=>{
    const root=mkdtempSync(join(tmpdir(),'workflow-prompt-error-'));roots.push(root);
    const candidate=join(root,'.saivage','config','prompts','agents','code','executor.md');
    mkdirSync(candidate,{recursive:true});
    expect(()=>compileProjectWorkflows(source(),{projectRoot:root})).toThrow(/EISDIR|illegal operation on a directory/u);
  });

  it('binds configured provider candidates once and fails when a required route has none',()=>{
    const valid=source();valid.providers={test:{models:['gpt-5.6'],capabilities:{contextWindowTokens:100_000,maxOutputTokens:10_000}}};const structural=compileProjectWorkflows(valid);const registry=new ProviderRegistry(valid);const bound=bindRuntimeWorkflows(structural,new ModelRouter(registry),registry,valid.compaction.context_utilization_fraction);
    expect(bound.runtimeBound).toBe(true);expect(bound.agentBindings.get('reviewer')?.candidateChain).toEqual([expect.objectContaining({provider:'test',model:'gpt-5.6'})]);
    const unavailable=source();const unbound=compileProjectWorkflows(unavailable);const unavailableRegistry=new ProviderRegistry(unavailable);expect(()=>bindRuntimeWorkflows(unbound,new ModelRouter(unavailableRegistry),unavailableRegistry,unavailable.compaction.context_utilization_fraction)).toThrow(/no capability-compatible configured provider candidate/);
  });

  it('rejects missing agents, invalid record-write authority, invalid child authority, and graph defects',()=>{
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.agent='missing';},/missing agent/);
    failure((value)=>{value.agents.executor!.record_writes=[];},/record_writes authority/);
    failure((value)=>{value.agents.planner!.can_create_children=false;},/cannot list create_card/);
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.edges={loop:{target:{node:'execute'},prompt:{reference:'execute',compactable:true}}};},/no path to a terminal/);
  });

  it('requires one card-scoped designated recipient and explicit valid alternatives for nonrecipient DONE edges',()=>{
    failure((value)=>{value.card_types.project!.workflow.notification_recipient='missing';},/notification_recipient references missing agent/);
    failure((value)=>{value.card_types.project!.workflow.notification_recipient='analyst';},/notification_recipient must use card session scope/);
    failure((value)=>{value.card_types.project!.workflow.notification_recipient='executor';},/is not used by any workflow node/);
    failure((value)=>{delete value.card_types.project!.workflow.nodes.review!.edges.approved!.pending_notifications;},/requires pending_notifications/);
    failure((value)=>{value.card_types.project!.workflow.nodes.review!.edges.approved!.pending_notifications={node:'review',prompt:{reference:'review-to-notifications',compactable:true}};},/target must run notification recipient/);
    failure((value)=>{value.card_types.project!.workflow.nodes.plan!.edges.complete_direct!.pending_notifications={node:'plan',prompt:{reference:'review-to-notifications',compactable:true}};},/allowed only on a nonrecipient DONE edge/);
    failure((value)=>{value.card_types.project!.workflow.nodes.review!.edges.revision_required!.pending_notifications={node:'plan',prompt:{reference:'review-to-notifications',compactable:true}};},/allowed only on a nonrecipient DONE edge/);
  });

  it('rejects unknown and wrong-scope tools during offline structural compilation',()=>{
    expect(source().agents.analyst!.tools).toContain('reopen_card');
    failure((value)=>{value.agents.planner!.tools.push('get_status');},/unknown tool 'get_status' for card session scope/);
    const selected=source();selected.agents.planner!.tools=selected.agents.planner!.tools.filter((name)=>name!=='reopen_card');expect(compileProjectWorkflows(selected).agents.get('planner')!.tools.map(({name})=>name)).not.toContain('reopen_card');
    failure((value)=>{value.agents.analyst!.tools.push('activate_card');},/unknown tool 'activate_card' for global session scope/);
    failure((value)=>{value.agents.reviewer!.tools.push('not_a_tool');},/unknown tool 'not_a_tool' for card session scope/);
  });

  it('uses intentionally local export and latest-node promotion validation',()=>{
    failure((value)=>{value.card_types.code!.workflow.nodes.execute!.edges.done!.target={terminal:'DONE',promote:'current',export_records:['brief.md']};},/without a source-node requirement/);
    const value=source();
    const code=value.card_types.code!;
    code.workflow.nodes.verify=structuredClone(code.workflow.nodes.execute!);
    code.workflow.nodes.execute!.edges.done={target:{node:'verify'},prompt:{reference:'execute',compactable:true}};
    code.workflow.nodes.verify!.edges.done={target:{terminal:'DONE',promote:{latest_node:'execute'},export_records:['status.md']}};
    const process=compileProjectWorkflows(value).cardTypes.get('code')!;
    const verify=process.states.get('node:verify')!;
    if(verify.kind!=='node') throw new Error('missing verify node');
    const done=verify.on.get('result:done')!;
    expect(done.semantic).toMatchObject({
      kind:'configured-outcome',
      terminalBehavior:{promotion:{kind:'latest-node',nodeId:'execute'}},
    });
    expect(process.states.get(done.targetStateId)).toMatchObject({
      kind:'terminal',terminal:'DONE',
    });
  });

  it('compiles strict record-write patterns, generic requirements, and the exact capability matrix',()=>{
    const defaults=compileProjectWorkflows(source());
    expect(defaults.agents.get('analyst')!.recordWrites.map(({source})=>source)).toEqual(['brief.md']);
    expect(defaults.agents.get('reviewer')!.recordWrites.map(({source})=>source)).toEqual(['review.md','review-*.md']);
    expect(defaults.agents.get('reviewer')!.recordWrites[1]!.matcher.test('review-notes-1.md')).toBe(true);
    expect(defaults.cardTypes.get('goal')!.states.get('node:review')).toMatchObject({requirements:[{mode:'clean',gate:'updated'}]});
    failure((value)=>{value.agents.executor!.record_writes.push('status.md');},/duplicate 'status.md'/);
    expect(saivageConfigSchema.safeParse({...structuredClone(DEFAULT_SAIVAGE_CONFIG),agents:{...structuredClone(DEFAULT_SAIVAGE_CONFIG.agents),executor:{...structuredClone(DEFAULT_SAIVAGE_CONFIG.agents.executor!),record_writes:['status?.md']}}}).success).toBe(false);

    for(const [mode,gate,needsWrite] of [['clean','exists',true],['clean','updated',true],['continue','updated',true],['continue','exists',false]] as const){
      const value=source();value.agents.matrix={...structuredClone(value.agents.executor!),tools:value.agents.executor!.tools.filter((tool)=>tool!=='write'&&tool!=='edit'),record_writes:['notes.md']};const execute=value.card_types.code!.workflow.nodes.execute!;execute.agent='matrix';value.card_types.code!.workflow.notification_recipient='matrix';execute.records={'notes.md':{mode,gate}};for(const edge of Object.values(execute.edges))if('terminal'in edge.target)edge.target.export_records=['notes.md'];
      if(needsWrite)expect(()=>compileProjectWorkflows(value)).toThrow(/requires the write tool/);else expect(()=>compileProjectWorkflows(value)).not.toThrow();
      if(needsWrite){value.agents.matrix!.tools.push('write');const node=compileProjectWorkflows(value).cardTypes.get('code')!.states.get('node:execute')!;if(node.kind!=='node')throw new Error('missing node');expect(node.requirements[0]!.definition).toMatchObject({name:'notes.md',schema:'authored-record.v1',declared:false});}
    }
  });

  it('requires descendant-context records across the transitive declared closure without glob coupling',()=>{
    const value=source();value.agents.reviewer!.record_writes=['review.md'];
    expect(()=>compileProjectWorkflows(value)).not.toThrow();
    delete value.card_types.architecture!.records['status.md'];
    expect(()=>compileProjectWorkflows(value)).toThrow(/descendant_context record 'status.md'.*architecture/);
  });

  it('marks configured same-node outcomes as semantic reentry without another destination locator',()=>{
    const value=source();value.card_types.code!.workflow.nodes.execute!.edges.retry={target:{node:'execute'},prompt:{reference:'execute',compactable:true}};
    const process=compileProjectWorkflows(value).cardTypes.get('code')!;const node=process.states.get('node:execute')!;if(node.kind!=='node')throw new Error('missing execute node');
    const route=node.on.get('result:retry')!;
    expect(route).toEqual({
      targetStateId:'node:execute',
      reenter:true,
      semantic:{kind:'configured-outcome',outcome:'retry',prompt:{promptId:'execute',compactable:true},terminalBehavior:null},
    });
    expect(process.states.get(route.targetStateId)).toBe(node);
    expect(Object.keys(route.semantic)).toEqual([
      'kind','outcome','prompt','terminalBehavior',
    ]);
  });

  it('keeps provider capacity out of structural workflow compilation',()=>{
    const value=source();
    value.agents['unused-worker']={...structuredClone(value.agents.executor!),model_route:'unused-route'};
    value.models.routes['unused-route']={candidates:['gpt-5.6'],temperature:0.3,max_tokens:32000};
    expect(()=>compileProjectWorkflows(value)).not.toThrow();
  });

});

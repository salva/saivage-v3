import { expect, test } from '@jest/globals';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { parse } from 'yaml';
import { publicNativeProject, publicNativeCli, nativeOptions, nativeIdentity } from '../../helpers/public-native-project.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { compileProjectWorkflows, bindRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { CardService } from '../../../src/cards/card-service.js';
import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { createObservedCollections } from '../../../src/retrieval/index.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import { createTestProcessRunner, cleanupTestProcessRunners } from '../../helpers/test-process-runner.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';

test.each(['native-direct','native-reviewed','native-replan','off-direct','off-reviewed'] as const)('selected bundle actual prepared contexts %s', async mode => {
  const root = publicNativeProject(), native = mode.startsWith('native'), reviewed = mode.endsWith('reviewed')||mode==='native-replan';
  const guidance = join(root,'.saivage/config/prompts/fragments/_shared'); mkdirSync(guidance,{recursive:true});
  for(const role of ['planner','executor','reviewer']) writeFileSync(join(guidance,`project-guidance-${role}.md`),
    'Synthetic project scope: preserve the documented test oracle; this guidance does not authorize accepting diagnostic observations as product evidence.');
  const init = publicNativeCli(root,'init',...(native?nativeOptions:['--profile','classic']));
  if(init.status!==0) throw new Error(init.stderr);
  const config=effectiveSaivageConfigSchema.parse(parse(readFileSync(join(root,'.saivage/saivage.yaml'),'utf8')));
  config.models=structuredClone(TEST_SAIVAGE_CONFIG.models); config.providers=structuredClone(TEST_SAIVAGE_CONFIG.providers);
  config.compaction=structuredClone(TEST_SAIVAGE_CONFIG.compaction);
  for(const agent of Object.values(config.agents)) agent.tools=agent.tools.filter(tool=>tool!=='view_image');
  const compiled=compileProjectWorkflows(config,{projectRoot:root}), registry=new ProviderRegistry(config);
  const workflows=bindRuntimeWorkflows(compiled,new ModelRouter(registry),registry,config.compaction.context_utilization_fraction,{internalAnalystEnabled:true});
  const cards=new CardService(root,compiled,NO_FRESHNESS_EFFECTS);
  const goal=cards.create({parent:'project',type:'goal',title:'Bounded aggregate',bootstrap_content:'Preserve the documented oracle.',priority:0,urgency:'normal',created_by:'analyst',depends_on:[]});
  const leaf=cards.create({parent:goal.id,type:'code',title:'Bounded leaf',bootstrap_content:'Complete a no-source-change qualification.',priority:0,urgency:'normal',created_by:'planner',depends_on:[]});
  const processes=createTestProcessRunner(root), counts=new Map<string,number>();
  const renders:unknown[]=[];
  let rootCandidate: unknown;
  let rootReview: unknown;
  let finish!:()=>void, running=false;
  const stopped=new Promise<void>(resolve=>{finish=resolve;});
  const prior=Object.fromEntries(Object.keys(nativeIdentity).map(k=>[k,process.env[k]])); Object.assign(process.env,nativeIdentity);
  const supervisor=createSupervisorRuntimeApi({...testAutonomousCompaction,workflows,retrieval:createObservedCollections(root),projectRoot:root,
    actorStore:cards,conversations:{projectRoot:root},runtimeGate:new RuntimeGate(),processRunner:processes.processRunner,
    runtimeProcessRootScope:processes.runtimeProcessRootScope,promptTemplates:createPromptTemplateRegistry(workflows),fatalPort:testApplicationFatalPort,
    freshness:NO_FRESHNESS_EFFECTS,runtimeStatusChanged:status=>{if(status==='running')running=true;if(status==='stopped'&&running)finish();},
    provider:scriptedAdmissionProvider(async input=>{
      const block=input.providerConversation.messages.find(m=>m.kind==='synthetic_context'&&m.block_identity.startsWith('node-activation:'));
      if(!block||block.kind!=='synthetic_context')throw new Error('Missing actual node context');
      const [,card,node]=block.block_identity.split(':');const key=`${card}/${node}`,n=(counts.get(key)??0)+1;counts.set(key,n);
      renders.push({key,turn:n,systemPrompt:input.systemPrompt,tools:input.tools,providerConversation:input.providerConversation});
      expect(input.systemPrompt).toContain('preserve the documented test oracle');
      expect(input.tools.some(t=>t.function.name==='checkpoint_source')).toBe(native&&input.sessionId.startsWith('agent:executor:'));
      const call=(name:string,args:object)=>({result:{kind:'tool_calls' as const,tool_calls:[{id:`${card}-${node}-${n}`,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]},provider_exchanges:[]});
      if(native&&node==='execute'&&n===1)return call('checkpoint_source',{});
      if(native&&node==='execute'&&n===2) {
        const checkpoint=input.providerConversation.messages.find(m=>m.kind==='tool_result'&&m.tool_call_id===`${card}-${node}-1`);
        expect(checkpoint&&JSON.parse(checkpoint.content)).toMatchObject({success:true});
        expect(cards.read(card!)!.lifecycle.status).toBe('running');
        expect(cards.read(card!)!.git!.candidate).toBeNull();
        return call('write',{path:`record:///status.md?card=${card}`,content:'Checkpoint captures source only; bounded no-change qualification now complete.'});
      }
      if(native&&node==='execute'&&n===3)return call('emit_result',{outcome:'done',summary:'Bounded no-change qualification, not checkpoint approval.'});
      if(node==='plan'&&n===1)return call('activate_card',{card_id:card==='project'?goal.id:leaf.id,instructions:'Complete the bounded no-change qualification.'});
      if(node==='review') {
        if(native&&card==='project'&&n===1)rootCandidate=cards.read('project')!.git!.candidate;
        if(n===1)return call('write',{path:`record:///review.md?card=${card}`,content:'Independent scoped no-change review; actual source and oracle unchanged.'});
        return call('emit_result',{outcome:'approved',summary:`Independent ${card} review`});
      }
      if(mode==='native-replan'&&card==='project') {
        if(node==='assess-completion'&&n===3) {
          expect(rootCandidate).not.toBeNull();expect(cards.read('project')!.git!.candidate).toEqual(rootCandidate);
          const review=cards.readRecordCurrent('project','review.md');
          if(review.kind!=='found'||!review.value.projection?.accepted)throw new Error('Missing independent review');
          rootReview=review.value.projection.accepted;
          expect(rootReview).toMatchObject({author:{kind:'agent',agent:'reviewer'},source_version:1});
          expect(JSON.stringify(input.providerConversation)).toContain(review.value.projection.acceptedVersionUrl!);
          return call('write',{path:'record:///status.md?card=project',content:'Bounded candidate accepted; continuing authorized scope remains. Ready to replan, not project DONE.'});
        }
        if(node==='assess-completion'&&n===4)return call('emit_result',{outcome:'replan',summary:'Return authorized remainder to planning.'});
        if(node==='plan'&&n===4) {
          expect(JSON.stringify(input.providerConversation)).toContain('record:///status.md?card=project&v=3');
          expect(cards.readRecordCurrent('project','review.md')).toMatchObject({kind:'found',value:{projection:{accepted:rootReview}}});
          expect(cards.read('project')!.lifecycle.status).toBe('running');
          return call('write',{path:'record:///status.md?card=project',content:'Remaining scope requires a concrete unavailable owner decision; bounded review remains unchanged.'});
        }
        if(node==='plan'&&n===5)return call('emit_result',{outcome:'blocked',summary:'Owner decision required for the remaining scope.'});
      }
      if(node==='plan'?n===2:n%2===1)return call('write',{path:`record:///status.md?card=${card}`,content:`Bounded ${key}/${n} qualification completed; no unrelated product completion claimed.`});
      const outcome=node==='execute'?'done':node==='plan'?(card==='project'?'assess_completion':reviewed?'admit_review':'complete_direct'):
        reviewed?(n===2?'admit_review':'complete_reviewed'):'complete_direct';
      return call('emit_result',{outcome,summary:`Closing ${card}/${node}`});
    })});
  try {
    await supervisor.startProject();await stopped;
    expect(cards.read('project')!.lifecycle.status).toBe(mode==='native-replan'?'blocked':'done');
    expect(counts.has(`${leaf.id}/execute`)).toBe(true);
    expect(counts.has(`${goal.id}/review`)).toBe(reviewed);expect(counts.has('project/review')).toBe(reviewed);
    expect(cards.read('project')!.git!==null).toBe(native);
  } finally {
    await supervisor.cleanupForApplicationStop();await cleanupTestProcessRunners(root);
    for(const [k,v] of Object.entries(prior))v===undefined?delete process.env[k]:process.env[k]=v;
    const bytes=JSON.stringify({mode,root,counts:[...counts],renders},null,2);
    writeFileSync(join(root,'.saivage/prepared-contexts.json'),bytes);
    writeFileSync(join(root,'.saivage/prepared-contexts.sha256'),createHash('sha256').update(bytes).digest('hex'));
    const evidence=process.env.SAIVAGE_TEST_COMPOSITION_EVIDENCE;
    if(evidence){mkdirSync(evidence,{recursive:true});writeFileSync(join(evidence,`native-context-${mode}.json`),bytes);}
  }
}, 900000);

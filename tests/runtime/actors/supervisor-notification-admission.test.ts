import { afterEach, describe, expect, it, jest } from '@jest/globals';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NO_FRESHNESS_EFFECTS } from '../../../src/contracts/index.js';
import { ConversationLLMActor } from '../../../src/runtime/actors/llm-actor.js';
import type { LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { createSupervisorRuntimeApi } from '../../../src/runtime/actors/supervisor-runtime-api.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { cardHeadFile, cardMailboxFile } from '../../../src/persistence/layout.js';
import { uuidV4Schema } from '../../../src/schemas/index.js';
import { CardService, initProjectTree, TEST_RUNTIME_WORKFLOWS } from '../../helpers/canonical-project.js';
import { scriptedAdmissionProvider, testAutonomousCompaction } from '../../helpers/llm-test-helpers.js';
import { createTestProcessRunner } from '../../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../../helpers/prompt-template-registry.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import type { CardActivationOwner } from '../../../src/runtime/actors/card-activation-owner.js';
import { ProviderTurnFailure } from '../../../src/contracts/index.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { readConversation, type ConversationFileContext } from '../../../src/persistence/conversation-file.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/publication-outcome.js';
import { testApplicationFatalDelivery } from '../../helpers/test-application-fatal-port.js';
import type { ManagedProcessPlatform } from '../../../src/runtime/managed-process-group-registry.js';
import { bindRuntimeWorkflows, compileProjectWorkflows, type CompiledRuntimeWorkflows } from '../../../src/runtime/card-process/card-process-config.js';
import { ProviderRegistry } from '../../../src/agents/provider.js';
import { ModelRouter } from '../../../src/agents/model-router.js';
import { TEST_SAIVAGE_CONFIG } from '../../helpers/test-saivage-config.js';
import { resolveSystemTemplate } from '../../../src/config/system-templates/registry.js';
import { effectiveSaivageConfigSchema } from '../../../src/schemas/saivage-config.js';
import { createPromptTemplateRegistry } from '../../../src/utils/prompt-api.js';
import { CardService as RuntimeCardService } from '../../../src/cards/card-service.js';
import { workflowResult } from '../../helpers/workflow-result.js';
import { createOversightNotificationPort } from '../../../src/application/oversight-notification-port.js';
import { submitNotificationTool } from '../../../src/tools/tool-api.js';
import { RuntimeStoppedInterruption } from '../../../src/runtime/actors/runtime-stopped-interruption.js';
import { appendActivationMarker } from '../../../src/runtime/actors/conversation-session.js';
import { appendStartupEvidence, appendStartupPendingCall } from '../../helpers/startup-session-fixtures.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for deterministic Supervisor test barrier.');
}

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function harness(provider: LLMProviderPort, changes?: NonNullable<ConversationFileContext['changes']>, processPlatform?: ManagedProcessPlatform, workflows?: CompiledRuntimeWorkflows, freshness = NO_FRESHNESS_EFFECTS) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-notification-admission-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const cards = workflows ? new RuntimeCardService(projectRoot, workflows, NO_FRESHNESS_EFFECTS) : new CardService(projectRoot);
  const processes = createTestProcessRunner(projectRoot, processPlatform);
  const supervisor = createSupervisorRuntimeApi({
    ...testAutonomousCompaction,
    ...(workflows ? { workflows } : {}),
    runtimeGate: new RuntimeGate(),
    projectRoot,
    processIdentity: { pid: 1, startedAt: '2026-09-09T00:00:00.000Z' },
    actorStore: cards,
    provider,
    conversations: { projectRoot, ...(changes ? { changes } : {}) },
    freshness,
    processRunner: processes.processRunner,
    runtimeProcessRootScope: processes.runtimeProcessRootScope,
    promptTemplates: workflows ? createPromptTemplateRegistry(workflows) : createTestPromptTemplateRegistry(),
    fatalPort: testApplicationFatalPort,
  });
  return { projectRoot, cards, supervisor };
}

function owner(supervisor: ReturnType<typeof createSupervisorRuntimeApi>): CardActivationOwner {
  const current = (supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get('project');
  if (!current) throw new Error('Expected current project activation owner.');
  return current;
}

function notification() {
  return { id: '00000000-0000-4000-8000-000000000001', content: 'must not be enqueued', created_at: '2026-09-09T00:00:01.000Z', source: 'test' };
}

function unverifiableProcessPlatform(): ManagedProcessPlatform {
  const child = Object.assign(new EventEmitter(), { pid: 4242, kill: jest.fn() }) as unknown as ChildProcess;
  return {
    spawn: () => child,
    probe: () => { throw Object.assign(new Error('process ownership cannot be verified'), { code: 'EPERM' }); },
    signal: () => { throw new Error('An unverifiable process group must not be signalled.'); },
  };
}

function workflowsWithExecutorNotification(): CompiledRuntimeWorkflows {
  const config = structuredClone(TEST_SAIVAGE_CONFIG);
  config.agents.executor!.tools = [...config.agents.executor!.tools, 'queue_notification'];
  const compiled = compileProjectWorkflows(config);
  const registry = new ProviderRegistry(config);
  return bindRuntimeWorkflows(compiled, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
}

const candidate = { provider: 'test', account: null, model: 'test-model' } as const;
function refusal(inputId: string, raw: string): ProviderTurnFailure {
  const attempt: ProviderExchangeAttempt = { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test-model', source_input_id: inputId, attempt_index: 0, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-09-09T00:00:00.000Z', completed_at: '2026-09-09T00:00:01.000Z', status: 'error', terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'refused' } };
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt], candidate, originalFailure: new LlmRequestError({ kind: 'content_policy', provider: 'test', message: 'refused', providerResponse: raw }) });
}

describe('Supervisor notification admission at terminal ownership', () => {
  it('joins a cancelled owned summary/evidence write before urgently publishing its card stopped', async () => {
    const summaryEntered = deferred();
    const summaryAborted = deferred();
    const releaseSummary = deferred();
    const events: string[] = [];
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner' && ++plannerCalls === 1)
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'dispatch-summary-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, undefined, TEST_RUNTIME_WORKFLOWS);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Held summary', bootstrap_content: 'brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    jest.spyOn(testAutonomousCompaction.compactor, 'shouldCompact').mockImplementation((input) => input.sessionId === `agent:executor:${childId}`);
    jest.spyOn(testAutonomousCompaction.compactor, 'compact').mockImplementation(async (args) => {
      summaryEntered.resolve();
      args.signal.addEventListener('abort', () => summaryAborted.resolve(), { once: true });
      await releaseSummary.promise;
      // Summary evidence may finish after cancellation. The exact owner must still be running.
      expect(h.cards.read(childId)!.lifecycle.status).toBe('running');
      appendStartupEvidence(h.projectRoot, args.input.sessionId);
      events.push('summary-evidence');
      throw args.signal.reason;
    });
    const originalStop = h.cards.stopRunning.bind(h.cards);
    const stop = jest.spyOn(h.cards, 'stopRunning').mockImplementation((id) => {
      expect(events).toEqual(['summary-evidence']); events.push('stopped'); return originalStop(id);
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await summaryEntered.promise;
    const urgent = h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000006', content: 'interrupt held summary', created_at: '2026-10-03T00:00:00.000Z' }, 'urgent');
    await summaryAborted.promise;
    expect(stop).not.toHaveBeenCalled();
    expect(h.cards.read(childId)!.lifecycle.status).toBe('running');
    releaseSummary.resolve();
    await expect(urgent).resolves.toMatchObject({ interruption: { status: 'interrupted', stopped_card_ids: [childId] } });
    expect(events).toEqual(['summary-evidence', 'stopped']);
    await h.supervisor.stopProject();
  });

  it('publishes running before a stopped session actual-use mate and every new ingress write', async () => {
    const entered = deferred();
    const events: string[] = [];
    let checkRunning = () => {};
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      checkRunning(); events.push('provider'); entered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, {
      conversationChanged: ({ visible_message_id }) => { checkRunning(); events.push(visible_message_id ?? 'conversation-write'); },
      agentMembershipChanged: () => { checkRunning(); },
    }, undefined, TEST_RUNTIME_WORKFLOWS);
    const input = '11111111-1111-4111-8111-111111111111';
    h.cards.setStatus('project', 'running');
    appendActivationMarker({ projectRoot: h.projectRoot }, 'agent:planner:project', { event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: input });
    appendStartupPendingCall(h.projectRoot, 'agent:planner:project', input);
    h.cards.stopRunning('project');
    await h.supervisor.start();
    expect(readConversation(h.projectRoot, 'agent:planner:project').unmatchedCall).not.toBeNull();
    checkRunning = () => { expect(h.cards.read('project')!.lifecycle.status).toBe('running'); };
    const activate = h.cards.activateStopped.bind(h.cards);
    jest.spyOn(h.cards, 'activateStopped').mockImplementation((...args) => {
      const result = activate(...args); events.push('running'); return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await entered.promise;
    expect(events[0]).toBe('running');
    expect(events[1]).toBe(`${input}:tool-result:pending`);
    expect(events.at(-1)).toBe('provider');
    expect(readConversation(h.projectRoot, 'agent:planner:project').unmatchedCall).toBeNull();
    await h.supervisor.stopProject();
  });

  it('re-enters typed architecture at Executor draft after interrupting Reviewer and repeats both reviews', async () => {
    const config=effectiveSaivageConfigSchema.parse(structuredClone(resolveSystemTemplate('classic-typed').config));
    config.providers={test:{models:['gpt-5.6'],capabilities:{contextWindowTokens:100_000,maxOutputTokens:10_000}}};
    const compiled=compileProjectWorkflows(config,{defaultPromptRoot:resolveSystemTemplate('classic-typed').promptRoot});
    const registry=new ProviderRegistry(config);
    const workflows=bindRuntimeWorkflows(compiled,new ModelRouter(registry),registry,config.compaction.context_utilization_fraction);
    let archId='';
    let rootCalls=0;
    let draftCalls=0;
    let reviewCalls=0;
    let resumedDraftInput='';
    const call=(id:string,name:string,args:unknown)=>({result:{kind:'tool_calls' as const,tool_calls:[{id,type:'function' as const,function:{name,arguments:JSON.stringify(args)}}]},provider_exchanges:[]});
    const provider=scriptedAdmissionProvider(async(input,signal)=>{
      if(input.sessionId==='agent:planner:project'){
        rootCalls++;
        if(rootCalls<=2)return call(`root-arch-${rootCalls}`,'activate_card',{card_id:archId});
      }else if(input.sessionId===`agent:executor:${archId}`){
        draftCalls++;
        if(draftCalls===3)resumedDraftInput=JSON.stringify(input.providerConversation.messages);
        return draftCalls%2===1
          ? call(`draft-record-${draftCalls}`,'write',{path:`record:///status.md?card=${archId}`,content:`architecture draft ${draftCalls}`})
          : call(`draft-result-${draftCalls}`,'emit_result',{outcome:'ready_for_component_review',summary:'draft ready'});
      }else if(input.sessionId===`agent:reviewer:${archId}`){
        reviewCalls++;
        if(reviewCalls===3)return await new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
        return reviewCalls%2===1
          ? call(`review-record-${reviewCalls}`,'write',{path:`record:///review.md?card=${archId}`,content:`review evidence ${reviewCalls}`})
          : call(`review-result-${reviewCalls}`,'emit_result',{outcome:'approved',summary:'review approved'});
      }
      return await new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    });
    const h=harness(provider,undefined,undefined,workflows);
    archId=h.cards.create({type:'architecture',parent:'project',title:'Architecture',bootstrap_content:'Brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[]}).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await waitFor(()=>reviewCalls>=3||h.supervisor.getStatus().status==='stopped'||h.supervisor.getStatus().status==='error');
    expect({rootCalls,draftCalls,reviewCalls,status:h.supervisor.getStatus().status}).toMatchObject({reviewCalls:3,status:'running'});
    await expect(h.supervisor.submitNotification(archId,{id:'00000000-0000-4000-8000-000000000002',content:'reassess architecture',created_at:'2026-09-09T00:00:02.000Z'},'urgent')).resolves.toEqual({queued:true,cardId:archId,notificationId:'00000000-0000-4000-8000-000000000002',interruption:{status:'interrupted',stopped_card_ids:[archId]}});
    await waitFor(()=>h.cards.read(archId)?.lifecycle.status==='done');
    expect(resumedDraftInput).toContain('reassess architecture');
    expect(rootCalls).toBe(3);
    expect(draftCalls).toBeGreaterThanOrEqual(4);
    expect(reviewCalls).toBe(8);
    expect(h.cards.read(archId)?.lifecycle.status).toBe('done');
    const rootRows=readConversation(h.projectRoot,'agent:planner:project').sourceRows;
    expect(rootRows.filter((row)=>row.kind==='tool_result'&&row.tool_call_id==='root-arch-1')).toHaveLength(1);
    const reviewerRows=readConversation(h.projectRoot,`agent:reviewer:${archId}`).sourceRows;
    for(const id of ['review-record-1','review-result-2','review-record-5','review-result-6','review-record-7','review-result-8']) {
      expect(reviewerRows.filter((row)=>row.kind==='tool_call'&&row.tool_call_id===id)).toHaveLength(1);
      expect(reviewerRows.filter((row)=>row.kind==='tool_result'&&row.tool_call_id===id)).toHaveLength(1);
    }
    await h.supervisor.stopProject();
  },15000);
  it.each(['failed', 'blocked'] as const)('routes past a %s ancestor produced by its real Planner workflow', async (terminal) => {
    const competitorEntered=deferred();
    const rootRecovered=deferred();
    let goalId='';
    let competitorId='';
    let rootCalls=0;
    let goalCalls=0;
    let rootInput='';
    const provider=scriptedAdmissionProvider(async (input,signal)=>{
      if(input.sessionId==='agent:planner:project'){
        rootCalls+=1;
        if(rootCalls<=2)return {result:{kind:'tool_calls' as const,tool_calls:[{id:`root-dispatch-${rootCalls}`,type:'function' as const,function:{name:'activate_card',arguments:JSON.stringify({card_id:rootCalls===1?goalId:competitorId})}}]},provider_exchanges:[]};
        rootInput=JSON.stringify(input.providerConversation.messages);
        rootRecovered.resolve();
      }else if(input.sessionId===`agent:planner:${goalId}`){
        goalCalls+=1;
        const call=goalCalls===1
          ? {name:'create_card',arguments:JSON.stringify({type:'code',title:'Backlog child',bootstrap_content:'Brief',priority:0,urgency:'normal',depends_on:[]})}
          : goalCalls===2
            ? {name:'write',arguments:JSON.stringify({path:`record:///status.md?card=${goalId}`,content:'evidence of unresolved work'})}
            : {name:'emit_result',arguments:JSON.stringify({outcome:terminal,summary:`Planner ${terminal}`})};
        return {result:{kind:'tool_calls' as const,tool_calls:[{id:`goal-${goalCalls}`,type:'function' as const,function:call}]},provider_exchanges:[]};
      }else competitorEntered.resolve();
      return await new Promise<never>((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
    });
    const h=harness(provider);
    goalId=h.cards.create({type:'goal',parent:'project',title:'Failed workstream',bootstrap_content:'Brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[]}).id;
    competitorId=h.cards.create({type:'code',parent:'project',title:'Competing work',bootstrap_content:'Brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[]}).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await competitorEntered.promise;
    expect(h.cards.read(goalId)?.lifecycle.status).toBe(terminal);
    expect(goalCalls).toBe(3);
    const childId=h.cards.listChildren(goalId)[0];
    if(!childId)throw new Error('Planner did not link backlog child.');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('backlog');
    if(terminal==='blocked')h.cards.enqueueNotification(goalId,{id:'00000000-0000-4000-8000-000000000003',content:'prior direct note',created_at:'2026-09-09T00:00:01.000Z'});
    const before=h.cards.read(goalId)!;
    await expect(h.supervisor.submitNotification(childId,{id:'00000000-0000-4000-8000-000000000004',content:'urgent backlog child',created_at:'2026-09-09T00:00:02.000Z'},'urgent')).resolves.toEqual({queued:true,cardId:childId,notificationId:'00000000-0000-4000-8000-000000000004',interruption:{status:'interrupted',stopped_card_ids:[competitorId]}});
    await rootRecovered.promise;
    expect(rootInput).toContain(`descendant '${childId}' needs attention through immediate child '${goalId}' (status observed when queued: ${terminal})`);
    expect(h.cards.read(goalId)).toEqual(before);
    expect(h.cards.read(childId)?.pending_notifications).toEqual(['00000000-0000-4000-8000-000000000004']);
    await h.supervisor.stopProject();
  },15000);
  it('lets each exact parent elect ordinary activation along an inactive urgent descendant path', async () => {
    const rootEntered = deferred();
    const targetEntered = deferred();
    let goalId = '';
    let targetId = '';
    let rootCalls = 0;
    let goalCalls = 0;
    let targetInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls += 1;
        if (rootCalls === 1) rootEntered.resolve();
        else return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-goal-on-urgent', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goalId }) } }] }, provider_exchanges: [] };
      } else if (input.sessionId === `agent:planner:${goalId}`) {
        goalCalls += 1;
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-leaf-on-urgent', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: targetId }) } }] }, provider_exchanges: [] };
      } else { targetInput = JSON.stringify(input.providerConversation.messages); targetEntered.resolve(); }
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h=harness(provider);
    goalId=h.cards.create({ type:'goal',parent:'project',title:'Goal',bootstrap_content:'Brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[] }).id;
    targetId=h.cards.create({ type:'code',parent:goalId,title:'Leaf',bootstrap_content:'Brief',priority:0,urgency:'normal',created_by:'analyst',depends_on:[] }).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await rootEntered.promise;
    await expect(h.supervisor.submitNotification(targetId,{ id:'00000000-0000-4000-8000-000000000005', content:'prompt leaf repair', created_at:'2026-09-09T00:00:03.000Z' },'urgent')).resolves.toEqual({ queued:true,cardId:targetId,notificationId:'00000000-0000-4000-8000-000000000005',interruption:{status:'interrupted',stopped_card_ids:[]} });
    await targetEntered.promise;
    expect(rootCalls).toBe(2);
    expect(goalCalls).toBe(1);
    expect(targetInput).toContain('prompt leaf repair');
    expect(h.cards.read(targetId)?.pending_notifications).toEqual([]);
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    await h.supervisor.stopProject();
  },15000);
  it('redispatches an urgently stopped active leaf through ordinary parent judgment and STOPPED recipient entry', async () => {
    const firstLeafEntered = deferred();
    const secondLeafEntered = deferred();
    let childId = '';
    let plannerCalls = 0;
    let leafCalls = 0;
    let secondInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        plannerCalls += 1;
        if (plannerCalls <= 2) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `dispatch-${plannerCalls}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      } else {
        leafCalls += 1;
        if (leafCalls === 1) firstLeafEntered.resolve();
        else { secondInput = JSON.stringify(input.providerConversation.messages); secondLeafEntered.resolve(); }
      }
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstLeafEntered.promise;
    await expect(h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000006', content: 'correct the active leaf', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: childId, notificationId: '00000000-0000-4000-8000-000000000006', interruption: { status: 'interrupted', stopped_card_ids: [childId] } });
    await secondLeafEntered.promise;
    expect(plannerCalls).toBe(2);
    expect(leafCalls).toBe(2);
    expect(secondInput).toContain('correct the active leaf');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const childVersions=h.cards.listCardVersions(childId);
    if(childVersions.kind!=='found')throw new Error('Missing child versions.');
    expect(childVersions.value.map((version)=>version.change?.change_reason).filter((reason)=>reason==='recovery stopped lifecycle'||reason==='STOPPED activation')).toEqual(['recovery stopped lifecycle','STOPPED activation']);
    const parentRows=readConversation(h.projectRoot,'agent:planner:project').sourceRows;
    for(const id of ['dispatch-1','dispatch-2']) expect(parentRows.filter((row)=>row.kind==='tool_call'&&row.tool_call_id===id)).toHaveLength(1);
    expect(parentRows.filter((row)=>row.kind==='tool_result'&&row.tool_call_id==='dispatch-1')).toHaveLength(1);
    await h.supervisor.stopProject();
  },15000);
  it.each(['stop', 'pause'] as const)('%s during root replacement publication cannot launch past its authority', async (action) => {
    const firstEntered = deferred();
    const replacementEntered = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls === 1) firstEntered.resolve(); else replacementEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const prior = owner(h.supervisor);
    const original = h.cards.activateStopped.bind(h.cards);
    let stopped: Promise<unknown> | null = null;
    let urgentSettled = false;
    jest.spyOn(h.cards, 'activateStopped').mockImplementation((id) => {
      const result = original(id);
      const replacement = owner(h.supervisor);
      expect(replacement).not.toBe(prior);
      expect(replacement.urgentSettlement).toBe(prior.urgentSettlement);
      expect(replacement.urgentSettlement).not.toBeNull();
      void replacement.urgentSettlement!.then(() => { urgentSettled = true; });
      if (action === 'stop') stopped = h.supervisor.stopProject(); else h.supervisor.pause();
      expect(urgentSettled).toBe(false);
      return result;
    });
    await expect(h.supervisor.submitNotification('project', { id: '00000000-0000-4000-8000-000000000007', content: 'launch context', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: 'project', notificationId: '00000000-0000-4000-8000-000000000007', interruption: action === 'stop' ? { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: ['project'] } : { status: 'interrupted', stopped_card_ids: ['project'] } });
    if (stopped) {
      await stopped;
      expect(urgentSettled).toBe(true);
      expect(h.supervisor.getStatus().status).toBe('stopped');
      expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
      expect(calls).toBe(1);
    } else {
      await waitFor(() => h.supervisor.getStatus().status === 'paused');
      expect(owner(h.supervisor)).not.toBe(prior);
      expect(owner(h.supervisor).urgentSettlement).toBeNull();
      expect(calls).toBe(1);
      h.supervisor.resume();
      await replacementEntered.promise;
      await h.supervisor.stopProject();
    }
  }, 15000);
  it('settles a root self-submission with a pending matched tool receipt before STOPPED replacement', async () => {
    const replacementEntered = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      calls += 1;
      if (calls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'root-self-notify', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'self urgent context', urgency: 'urgent' }) } }] }, provider_exchanges: [] };
      replacementEntered.resolve();
      expect(JSON.stringify(input.providerConversation.messages)).toContain('self urgent context');
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    expect((await h.supervisor.startProject()).started).toBe(true);
    await replacementEntered.promise;
    expect(owner(h.supervisor).urgentSettlement).toBeNull();
    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const matches = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'root-self-notify');
    expect(matches).toHaveLength(1);
    expect(matches[0]!.content).toContain('pending_tool_settlement');
    expect(matches[0]!.content).not.toContain('stopped_card_ids');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(calls).toBe(2);
    await h.supervisor.stopProject();
  }, 15000);

  it.each(['stop', 'pause'] as const)('%s at a root interruption claim owns replacement precedence', async (action) => {
    const providerEntered = deferred();
    const joinEntered = deferred();
    const releaseJoin = deferred();
    const replacementEntered = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls === 1) providerEntered.resolve(); else replacementEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    expect((await h.supervisor.startProject()).started).toBe(true);
    await providerEntered.promise;
    const prior = owner(h.supervisor);
    const originalJoin = prior.processor.joinActivation.bind(prior.processor);
    jest.spyOn(prior.processor, 'joinActivation').mockImplementation(async () => {
      const result = await originalJoin();
      joinEntered.resolve();
      await releaseJoin.promise;
      return result;
    });
    const submitted = h.supervisor.submitNotification('project', { id: '00000000-0000-4000-8000-000000000008', content: 'interrupt', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent');
    await joinEntered.promise;
    const stopping = action === 'stop' ? h.supervisor.stopProject() : null;
    if (action === 'pause') h.supervisor.pause();
    releaseJoin.resolve();
    await expect(submitted).resolves.toEqual({ queued: true, cardId: 'project', notificationId: '00000000-0000-4000-8000-000000000008', interruption: action === 'stop' ? { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } : { status: 'interrupted', stopped_card_ids: ['project'] } });
    if (stopping) {
      await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
      expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
      expect(h.cards.read('project')?.lifecycle.status).toBe('running');
      expect(calls).toBe(1);
    } else {
      await waitFor(() => h.supervisor.getStatus().status === 'paused');
      expect(owner(h.supervisor)).not.toBe(prior);
      expect(calls).toBe(1);
      h.supervisor.resume();
      await replacementEntered.promise;
      expect(calls).toBe(2);
      await h.supervisor.stopProject();
    }
  }, 15000);
  it('replaces a root after stopping its descendant and itself inside the same run', async () => {
    const childEntered = deferred();
    const replacementEntered = deferred();
    let childId = '';
    let rootCalls = 0;
    let replacementInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls += 1;
        if (rootCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'root-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        replacementInput = JSON.stringify(input.providerConversation.messages);
        replacementEntered.resolve();
      } else childEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const start = await h.supervisor.startProject();
    expect(start.started).toBe(true);
    await childEntered.promise;
    const prior = owner(h.supervisor);
    const originalJoin = prior.processor.joinActivation.bind(prior.processor);
    let oldJoined = false;
    jest.spyOn(prior.processor, 'joinActivation').mockImplementation(async () => {
      const result = await originalJoin();
      oldJoined = true;
      return result;
    });
    const rootVersions = h.cards.listCardVersions('project');
    if (rootVersions.kind !== 'found') throw new Error('Expected root history.');
    await expect(h.supervisor.submitNotification('project', { id: '00000000-0000-4000-8000-000000000009', content: 'urgent root context', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: 'project', notificationId: '00000000-0000-4000-8000-000000000009', interruption: { status: 'interrupted', stopped_card_ids: [childId, 'project'] } });
    await replacementEntered.promise;
    expect(owner(h.supervisor)).not.toBe(prior);
    expect(oldJoined).toBe(true);
    expect(owner(h.supervisor).entry).toBe('STOPPED');
    expect(h.supervisor.getStatus().status).toBe('running');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('stopped');
    expect(rootCalls).toBe(2);
    const versions = h.cards.listCardVersions('project');
    if (versions.kind !== 'found') throw new Error('Expected root history.');
    const reasons = versions.value.slice(rootVersions.value.length).map((version) => version.change?.change_reason);
    expect(reasons).toEqual(['recovery stopped lifecycle', 'STOPPED activation']);
    expect(h.cards.read('project')?.pending_notifications).toEqual([]);
    const rootRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rootRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'root-child')).toHaveLength(1);
    expect(rootRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'root-child')).toHaveLength(1);
    expect(replacementInput).toContain('urgent root context');
    await h.supervisor.stopProject();
  }, 15000);
  it('admits a direct urgent BLOCKED target under a live parent without changing its lifecycle', async () => {
    const firstEntered = deferred();
    const recovered = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls === 1) firstEntered.resolve(); else recovered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const blocked = h.cards.create({ type: 'code', parent: 'project', title: 'Blocked target', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    h.cards.setStatus(blocked.id, 'running');
    h.cards.commitActivationOutcome(blocked.id, { status: 'blocked', summary: 'waiting', result: workflowResult('BLOCKED', 'waiting') }, '2026-09-09T00:00:00.000Z');
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    await expect(h.supervisor.submitNotification(blocked.id, { id: '00000000-0000-4000-8000-00000000000a', content: 'urgent blocked card', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: blocked.id, notificationId: '00000000-0000-4000-8000-00000000000a', interruption: { status: 'interrupted', stopped_card_ids: [] } });
    await recovered.promise;
    expect(h.cards.read(blocked.id)?.lifecycle.status).toBe('blocked');
    expect(h.cards.read(blocked.id)?.pending_notifications).toEqual(['00000000-0000-4000-8000-00000000000a']);
    await h.supervisor.stopProject();
  }, 15000);
  it('enqueues every eligible inactive ancestor bottom-up through the real running boundary', async () => {
    const firstEntered = deferred();
    const recovered = deferred();
    let calls = 0;
    let recoveryInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      calls += 1;
      if (calls === 1) firstEntered.resolve();
      else { recoveryInput = JSON.stringify(input.providerConversation.messages.map((message) => 'content' in message ? message.content : '')); recovered.resolve(); }
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const parent = h.cards.create({ type: 'goal', parent: 'project', title: 'Inactive goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const target = h.cards.create({ type: 'code', parent: parent.id, title: 'Inactive leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const appended: string[] = [];
    const original = h.cards.enqueueNotification.bind(h.cards);
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => { appended.push(args[0]); return original(...args); });
    await expect(h.supervisor.submitNotification(target.id, { id: '00000000-0000-4000-8000-00000000000b', content: 'urgent leaf', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: target.id, notificationId: '00000000-0000-4000-8000-00000000000b', interruption: { status: 'interrupted', stopped_card_ids: [] } });
    expect(appended).toEqual([target.id, parent.id, 'project']);
    const messages = [target.id, parent.id].flatMap(cardId => h.cards.readPendingNotifications(cardId).map(notification => {
      expect(uuidV4Schema.parse(notification.id)).toBe(notification.id);
      const head = JSON.parse(readFileSync(cardHeadFile(h.projectRoot, cardId), 'utf8'));
      expect(head.pending).toContain(notification.id);
      expect(JSON.parse(readFileSync(cardMailboxFile(h.projectRoot, cardId, notification.id), 'utf8'))).toMatchObject({ card_id: cardId, notification });
      return notification;
    }));
    expect(new Set(messages.map(message => message.id)).size).toBe(messages.length);
    expect(h.cards.readPendingNotifications(parent.id)[0]?.content).toContain(`immediate child '${target.id}'`);
    await recovered.promise;
    expect(recoveryInput.includes(`descendant '${target.id}' needs attention through immediate child '${parent.id}'`)).toBe(true);
    expect(h.cards.read(parent.id)?.lifecycle.status).toBe('backlog');
    await h.supervisor.stopProject();
  }, 15000);
  it('stops at the nearest real active eligible ancestor without notifying a higher owner', async () => {
    const competingEntered = deferred();
    const goalRecovered = deferred();
    let goalId = '';
    let competitorId = '';
    let goalCalls = 0;
    let rootCalls = 0;
    let recipientInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls += 1;
        if (rootCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-goal', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goalId }) } }] }, provider_exchanges: [] };
        throw new Error('Higher root provider continued despite goal boundary.');
      }
      if (input.sessionId === `agent:planner:${goalId}`) {
        goalCalls += 1;
        if (goalCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-competitor', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: competitorId }) } }] }, provider_exchanges: [] };
        recipientInput = JSON.stringify(input.providerConversation.messages.map((message) => 'content' in message ? message.content : ''));
        goalRecovered.resolve();
      } else competingEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    goalId = h.cards.create({ type: 'goal', parent: 'project', title: 'Active goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const target = h.cards.create({ type: 'code', parent: goalId, title: 'Inactive target', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    competitorId = h.cards.create({ type: 'code', parent: goalId, title: 'Competing child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await competingEntered.promise;
    const rootBefore = h.cards.read('project')!;
    await expect(h.supervisor.submitNotification(target.id, { id: '00000000-0000-4000-8000-00000000000c', content: 'urgent target', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: target.id, notificationId: '00000000-0000-4000-8000-00000000000c', interruption: { status: 'interrupted', stopped_card_ids: [competitorId] } });
    await goalRecovered.promise;
    expect(recipientInput.includes(`descendant '${target.id}' needs attention through immediate child '${target.id}'`)).toBe(true);
    expect(h.cards.read('project')).toEqual(rootBefore);
    expect(h.cards.read(goalId)?.lifecycle.status).toBe('running');
    expect(rootCalls).toBe(1);
    await h.supervisor.stopProject();
  }, 15000);
  it('skips an ancestor with a real claimed result winner without stealing its settlement', async () => {
    const held = deferred();
    const claimEntered = deferred();
    const original = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settled = original.apply(this, args);
      claimEntered.resolve();
      return settled.then(async (facts) => { await held.promise; return facts; });
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${calls}`, type: 'function' as const, function: calls === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'failed' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'failed', summary: 'root failed' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const child = h.cards.create({ type: 'code', parent: 'project', title: 'Backlog', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await claimEntered.promise;
    await waitFor(() => owner(h.supervisor).terminalWinner === 'result');
    const rootBefore = h.cards.read('project')!;
    await expect(h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-00000000000d', content: 'do not steal owner', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: child.id, notificationId: '00000000-0000-4000-8000-00000000000d', interruption: { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] } });
    expect(h.cards.read('project')).toEqual(rootBefore);
    expect(h.cards.read(child.id)?.pending_notifications).toEqual(['00000000-0000-4000-8000-00000000000d']);
    held.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.cards.read('project')?.lifecycle.status).toBe('failed');
  }, 15000);
  it.each(['decline', 'activate'] as const)('skips a BLOCKED ancestor while a real root owner chooses to %s', async (choice) => {
    const competingEntered = deferred();
    const recoveryEntered = deferred();
    const releaseDecision = deferred();
    const blockedEntered = deferred();
    let blockedId = '';
    let competitorId = '';
    let rootCalls = 0;
    let recoveryInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls += 1;
        if (rootCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'competing-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: competitorId }) } }] }, provider_exchanges: [] };
        recoveryInput = JSON.stringify(input.providerConversation.messages.map((message) => 'content' in message ? message.content : ''));
        recoveryEntered.resolve();
        if (choice === 'activate') {
          await releaseDecision.promise;
          return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-blocked', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: blockedId }) } }] }, provider_exchanges: [] };
        }
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (input.sessionId === `agent:planner:${blockedId}`) blockedEntered.resolve();
      else competingEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    blockedId = h.cards.create({ type: 'goal', parent: 'project', title: 'Blocked', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const descendant = h.cards.create({ type: 'code', parent: blockedId, title: 'Backlog', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    competitorId = h.cards.create({ type: 'code', parent: 'project', title: 'Competitor', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    h.cards.setStatus(blockedId, 'running');
    h.cards.commitActivationOutcome(blockedId, { status: 'blocked', summary: 'waiting', result: workflowResult('BLOCKED', 'waiting') }, '2026-09-09T00:00:00.000Z');
    h.cards.enqueueNotification(blockedId, { id: '00000000-0000-4000-8000-00000000000e', content: 'retained direct note', created_at: '2026-09-09T00:00:01.000Z' });
    const blockedBefore = h.cards.read(blockedId)!;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await competingEntered.promise;
    await expect(h.supervisor.submitNotification(descendant.id, { id: '00000000-0000-4000-8000-00000000000f', content: 'urgent original', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: descendant.id, notificationId: '00000000-0000-4000-8000-00000000000f', interruption: { status: 'interrupted', stopped_card_ids: [competitorId] } });
    await recoveryEntered.promise;
    expect(recoveryInput.includes(`descendant '${descendant.id}' needs attention through immediate child '${blockedId}' (status observed when queued: blocked)`)).toBe(true);
    expect(h.cards.read(blockedId)).toEqual(blockedBefore);
    expect(h.cards.read(competitorId)?.lifecycle.status).toBe('stopped');
    if (choice === 'activate') {
      releaseDecision.resolve();
      await blockedEntered.promise;
      expect(h.cards.read(blockedId)?.lifecycle.status).toBe('running');
      expect(h.cards.read(descendant.id)?.pending_notifications).toHaveLength(1);
    } else expect(rootCalls).toBe(2);
    await h.supervisor.stopProject();
  }, 15000);
  it.each(['failed', 'blocked'] as const)('queues across a %s ancestor without an active owner and preserves direct BLOCKED admission', async (status) => {
    const h = harness(scriptedAdmissionProvider(async () => { throw new Error('Queue-only urgency must not launch a provider.'); }));
    const parent = h.cards.create({ type: 'goal', parent: 'project', title: 'Resting parent', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const target = h.cards.create({ type: 'code', parent: parent.id, title: 'Backlog', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    h.cards.setStatus(parent.id, 'running');
    h.cards.commitActivationOutcome(parent.id, { status, summary: 'prior outcome', result: workflowResult(status === 'blocked' ? 'BLOCKED' : 'FAILED', 'prior outcome') }, '2026-09-09T00:00:00.000Z');
    if (status === 'blocked') h.cards.enqueueNotification(parent.id, { id: '00000000-0000-4000-8000-000000000010', content: 'direct earlier note', created_at: '2026-09-09T00:00:01.000Z' });
    const prior = h.cards.read(parent.id)!;
    await expect(h.supervisor.submitNotification(target.id, { id: '00000000-0000-4000-8000-000000000011', content: 'act on backlog', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: target.id, notificationId: '00000000-0000-4000-8000-000000000011', interruption: { status: 'not_applicable' } });
    expect(h.cards.read(parent.id)).toEqual(prior);
    expect(h.cards.read('project')?.pending_notifications).toHaveLength(1);
    expect(h.cards.readPendingNotifications('project')[0]?.content).toContain(`descendant '${target.id}' needs attention through immediate child '${parent.id}' (status observed when queued: ${status})`);
    expect(h.cards.read(target.id)?.pending_notifications).toEqual(['00000000-0000-4000-8000-000000000011']);
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
    if (status === 'blocked') {
      expect(h.supervisor.notifyCard(parent.id, { id: '00000000-0000-4000-8000-000000000012', content: 'direct target remains open', created_at: '2026-09-09T00:00:03.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000012' });
      await expect(h.supervisor.submitNotification(parent.id, { id: '00000000-0000-4000-8000-000000000013', content: 'direct urgent target', created_at: '2026-09-09T00:00:04.000Z' }, 'urgent')).resolves.toMatchObject({ queued: true, interruption: { status: 'not_applicable' } });
      expect(h.cards.read(parent.id)?.pending_notifications).toEqual(['00000000-0000-4000-8000-000000000010', '00000000-0000-4000-8000-000000000012', '00000000-0000-4000-8000-000000000013']);
    }
  }, 15000);

  it('queues only the target when project and every ancestor are cascade-ineligible', async () => {
    const h = harness(scriptedAdmissionProvider(async () => { throw new Error('Queue-only urgency cannot launch a provider.'); }));
    const parent = h.cards.create({ type: 'goal', parent: 'project', title: 'Failed parent', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const child = h.cards.create({ type: 'code', parent: parent.id, title: 'Backlog', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    for (const id of [parent.id, 'project']) {
      h.cards.setStatus(id, 'running');
      h.cards.commitActivationOutcome(id, { status: 'failed', summary: 'prior failure', result: workflowResult('FAILED', 'prior failure') }, '2026-09-09T00:00:00.000Z');
    }
    const parentBefore = h.cards.read(parent.id)!;
    const projectBefore = h.cards.read('project')!;
    await expect(h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-000000000014', content: 'known urgent', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: child.id, notificationId: '00000000-0000-4000-8000-000000000014', interruption: { status: 'not_applicable' } });
    expect(h.cards.read(parent.id)).toEqual(parentBefore);
    expect(h.cards.read('project')).toEqual(projectBefore);
    expect(h.cards.read(child.id)?.pending_notifications).toEqual(['00000000-0000-4000-8000-000000000014']);
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
  }, 15000);
  it.each(['decline', 'reopen'] as const)('routes a failed-parent backlog descendant across the skipped parent when root chooses to %s', async (choice) => {
    const competingEntered = deferred();
    const recoveryEntered = deferred();
    const goalEntered = deferred();
    let goalId = '';
    let competitorId = '';
    const rootInputs: string[] = [];
    let rootCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.sessionId === 'agent:planner:project') {
        rootCalls += 1;
        rootInputs.push(JSON.stringify(input.providerConversation.messages.map((message) => 'content' in message ? message.content : '')));
        if (rootCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-competitor', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: competitorId }) } }] }, provider_exchanges: [] };
        recoveryEntered.resolve();
        if (choice === 'reopen' && rootCalls === 2) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'reopen-goal', type: 'function' as const, function: { name: 'reopen_card', arguments: JSON.stringify({ card_id: goalId }) } }] }, provider_exchanges: [] };
        if (choice === 'reopen' && rootCalls === 3) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-goal', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: goalId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (input.sessionId === `agent:planner:${goalId}`) goalEntered.resolve();
      else competingEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    goalId = h.cards.create({ type: 'goal', parent: 'project', title: 'Failed goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const descendant = h.cards.create({ type: 'code', parent: goalId, title: 'Backlog', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    competitorId = h.cards.create({ type: 'code', parent: 'project', title: 'Competitor', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    h.cards.setStatus(goalId, 'running');
    h.cards.commitActivationOutcome(goalId, { status: 'failed', summary: 'prior failure', result: workflowResult('FAILED', 'prior failure') }, '2026-09-09T00:00:00.000Z');
    expect((await h.supervisor.startProject()).started).toBe(true);
    await competingEntered.promise;
    const priorGoal = h.cards.read(goalId)!;
    await expect(h.supervisor.submitNotification(descendant.id, { id: '00000000-0000-4000-8000-000000000015', content: 'urgent backlog descendant', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toEqual({ queued: true, cardId: descendant.id, notificationId: '00000000-0000-4000-8000-000000000015', interruption: { status: 'interrupted', stopped_card_ids: [competitorId] } });
    await recoveryEntered.promise;
    expect(rootInputs[1]).toContain(descendant.id);
    expect(rootInputs[1]).toContain(goalId);
    expect(rootInputs[1]).toContain('status observed when queued: failed');
    expect(h.cards.read(competitorId)?.lifecycle.status).toBe('stopped');
    expect(h.cards.read(descendant.id)?.pending_notifications).toHaveLength(1);
    if (choice === 'decline') {
      expect(h.cards.read(goalId)).toEqual(priorGoal);
      expect(rootCalls).toBe(2);
    } else {
      await goalEntered.promise;
      expect(h.cards.read(goalId)?.lifecycle.status).toBe('running');
      expect(h.cards.read(descendant.id)?.pending_notifications).toHaveLength(1);
      expect(rootInputs.join('\n')).not.toContain(`agent:executor:${descendant.id}`);
    }
    await h.supervisor.stopProject();
  }, 15000);
  it.each(['stop', 'pause'] as const)('preserves a claimed child binder receipt when %s takes over before tool unwind', async (control) => {
    const resultPublished = deferred();
    const releaseResult = deferred();
    const recipientEntered = deferred();
    let childId = '';
    let siblingId = '';
    let plannerCalls = 0;
    let executorCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-notifier', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        recipientEntered.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      executorCalls += 1;
      if (executorCalls !== 1) throw new Error('Submitting child resumed provider execution.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'child-urgent', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: siblingId, kind: 'correction', body: 'attend sibling', urgency: 'urgent' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider, undefined, undefined, workflowsWithExecutorNotification());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Notifier', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    siblingId = h.cards.create({ type: 'code', parent: 'project', title: 'Sibling', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const original = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settled = original.apply(this, args);
      if (this.agentId !== `agent:executor:${childId}`) return settled;
      return settled.then(async (facts) => { resultPublished.resolve(); await releaseResult.promise; return facts; });
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await resultPublished.promise;
    const childRows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    expect(childRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'child-urgent')).toHaveLength(1);
    expect(childRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'child-urgent')?.content).toContain('"status":"pending_tool_settlement"');
    let stopping: Promise<unknown> | null = null;
    if (control === 'stop') stopping = h.supervisor.stopProject();
    else h.supervisor.pause();
    releaseResult.resolve();
    if (stopping) {
      await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
      expect(plannerCalls).toBe(1);
    } else {
      await waitFor(() => h.supervisor.getStatus().status === 'paused');
      expect(plannerCalls).toBe(1);
      h.supervisor.resume();
      await recipientEntered.promise;
      await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    }
    expect(executorCalls).toBe(1);
    expect(h.cards.read(siblingId)?.pending_notifications).toHaveLength(1);
  }, 15000);
  it('settles a real child binder urgent self-in-scope receipt before parent recovery', async () => {
    const recipientEntered = deferred();
    let childId = '';
    let siblingId = '';
    let plannerCalls = 0;
    let executorCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-notifier', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        recipientEntered.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      executorCalls += 1;
      if (executorCalls !== 1) throw new Error('Submitting child continued its provider after interruption.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'child-urgent', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: siblingId, kind: 'correction', body: 'attend sibling', urgency: 'urgent' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider, undefined, undefined, workflowsWithExecutorNotification());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Notifier', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    siblingId = h.cards.create({ type: 'code', parent: 'project', title: 'Sibling', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await recipientEntered.promise;
    expect(h.cards.read(childId)?.lifecycle.status).toBe('stopped');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(siblingId)?.pending_notifications).toHaveLength(1);
    const childRows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    expect(childRows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'child-urgent')).toHaveLength(1);
    const results = childRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'child-urgent');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(results[0]?.content).toContain('"status":"pending_tool_settlement"');
    const rootRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rootRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-notifier')).toHaveLength(1);
    expect(rootRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-notifier')?.content).toContain('"outcome":"stopped"');
    expect(executorCalls).toBe(1);
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  }, 15000);
  it('owns retiring-node join failure through the claimed task and runtime containment', async () => {
    const firstEntered = deferred();
    const failure = new Error('retiring LLM join failed');
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      firstEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const child = h.cards.create({ type: 'code', parent: 'project', title: 'Inactive', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const originalJoin = ConversationLLMActor.prototype.join;
    let failed = false;
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(async function (this: ConversationLLMActor) {
      const result = await originalJoin.call(this);
      if (!failed && this.agentId === 'agent:planner:project') { failed = true; throw failure; }
      return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    await expect(h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-000000000016', content: 'known enqueue', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).rejects.toBe(failure);
    await waitFor(() => h.supervisor.getStatus().status === 'error');
    expect(calls).toBe(1);
    expect(h.cards.read(child.id)?.pending_notifications).toHaveLength(1);
  }, 15000);
  it('suppresses urgent interruption when Pause already owns admission and resumes the original node', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const continued = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        await releaseFirst.promise;
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'read-after-pause', type: 'function' as const, function: { name: 'read', arguments: JSON.stringify({ path: 'record:///brief.md?card=project' }) } }] }, provider_exchanges: [] };
      }
      continued.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const child = h.cards.create({ type: 'code', parent: 'project', title: 'Inactive', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    h.supervisor.pause();
    await expect(h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-000000000017', content: 'retain note', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent')).resolves.toMatchObject({ queued: true, interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    expect(owner(h.supervisor).processor.processPosition()).toMatchObject({ kind: 'node', executionOrdinal: 0 });
    expect(calls).toBe(1);
    releaseFirst.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'paused');
    expect(calls).toBe(1);
    h.supervisor.resume();
    await continued.promise;
    expect(owner(h.supervisor).processor.processPosition()).toMatchObject({ kind: 'node', executionOrdinal: 0 });
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  }, 15000);

  it.each(['resume', 'stop'] as const)('completes a claimed urgent node under Pause, then %s at the ordinary frontier', async (next) => {
    const firstEntered = deferred();
    const oldJoined = deferred();
    const releaseJoin = deferred();
    const resumed = deferred();
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      resumed.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const child = h.cards.create({ type: 'code', parent: 'project', title: 'Inactive', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const originalJoin = ConversationLLMActor.prototype.join;
    let held = false;
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(async function (this: ConversationLLMActor) {
      const result = await originalJoin.call(this);
      if (!held && this.agentId === 'agent:planner:project') {
        held = true;
        oldJoined.resolve();
        await releaseJoin.promise;
      }
      return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const submit = h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-000000000018', content: 'queued during join', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent');
    await oldJoined.promise;
    h.supervisor.pause();
    expect(h.supervisor.getStatus().status).toBe('pausing');
    expect(calls).toBe(1);
    releaseJoin.resolve();
    await expect(submit).resolves.toMatchObject({ queued: true, interruption: { status: 'interrupted', stopped_card_ids: [] } });
    await waitFor(() => h.supervisor.getStatus().status === 'paused');
    expect(calls).toBe(1);
    if (next === 'resume') {
      h.supervisor.resume();
      await resumed.promise;
      expect(calls).toBe(2);
    }
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(calls).toBe(next === 'resume' ? 2 : 1);
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
  }, 15000);
  it.each(['guarded', 'control-transition'] as const)('lets public Stop take over the %s real actor without a successor call', async (point) => {
    const firstEntered = deferred();
    const oldJoined = deferred();
    const releaseJoin = deferred();
    let calls = 0;
    let h!: ReturnType<typeof harness>;
    let stop: Promise<unknown> | null = null;
    let stopSettled = false;
    let childId = '';
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      calls += 1;
      if (calls !== 1) throw new Error('Successor provider entered after Stop takeover.');
      firstEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const freshness = {
      ...NO_FRESHNESS_EFFECTS,
      agentMembershipChanged(target: { scope: string; cardId?: string }): void {
        if (point !== 'control-transition' || stop || target.cardId !== 'project' || !h || !childId) return;
        if (h.supervisor.getActorRuntimeReadModel().cards.some((row) => row.cardId === 'project' && row.processState?.kind === 'node' && row.processState.executionOrdinal === 1)) {
          stop = h.supervisor.stopProject();
          void stop.then(() => { stopSettled = true; }, () => { stopSettled = true; });
        }
      },
    };
    h = harness(provider, undefined, undefined, undefined, freshness);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Inactive', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const originalJoin = ConversationLLMActor.prototype.join;
    let held = false;
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(async function (this: ConversationLLMActor) {
      const result = await originalJoin.call(this);
      if (!held && this.agentId === 'agent:planner:project') {
        held = true;
        oldJoined.resolve();
        await releaseJoin.promise;
      }
      return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const submit = h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000019', content: 'stop race', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent');
    await oldJoined.promise;
    if (point === 'guarded') {
      stop = h.supervisor.stopProject();
      void stop.then(() => { stopSettled = true; }, () => { stopSettled = true; });
    }
    expect(stop).not.toBeNull();
    await Promise.resolve();
    expect(stopSettled).toBe(false);
    expect(calls).toBe(1);
    releaseJoin.resolve();
    await expect(submit).resolves.toMatchObject({ queued: true, interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    await expect(stop!).resolves.toEqual({ status: 'stopped', contained: true });
    expect(calls).toBe(1);
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
  }, 15000);
  it('guards the real surviving recipient until the retired LLM join returns', async () => {
    const firstEntered = deferred();
    const successorEntered = deferred();
    const oldJoined = deferred();
    const releaseOldJoin = deferred();
    let calls = 0;
    let successorInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      calls += 1;
      if (calls === 1) {
        firstEntered.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      successorInput = JSON.stringify(input);
      successorEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const child = h.cards.create({ type: 'code', parent: 'project', title: 'Inactive', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const originalJoin = ConversationLLMActor.prototype.join;
    let held = false;
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(async function (this: ConversationLLMActor) {
      const result = await originalJoin.call(this);
      if (!held && this.agentId === 'agent:planner:project') {
        held = true;
        oldJoined.resolve();
        await releaseOldJoin.promise;
      }
      return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const recordPreparation = jest.spyOn(h.cards, 'readRecordCurrent');
    const before = readConversation(h.projectRoot, 'agent:planner:project').sourceRows.length;
    const submit = h.supervisor.submitNotification(child.id, { id: '00000000-0000-4000-8000-00000000001a', content: 'Attend to inactive child', created_at: '2026-09-09T00:00:03.000Z' }, 'urgent');
    await oldJoined.promise;
    expect(owner(h.supervisor).processor.processPosition()).toMatchObject({ kind: 'node', executionOrdinal: 1 });
    expect(calls).toBe(1);
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read('project')?.pending_notifications).toHaveLength(1);
    expect(readConversation(h.projectRoot, 'agent:planner:project').sourceRows.slice(before).map((row) => row.kind)).toEqual(['model_issue']);
    expect(recordPreparation).not.toHaveBeenCalled();
    releaseOldJoin.resolve();
    await expect(submit).resolves.toEqual({ queued: true, cardId: child.id, notificationId: '00000000-0000-4000-8000-00000000001a', interruption: { status: 'interrupted', stopped_card_ids: [] } });
    await successorEntered.promise;
    expect(successorInput.includes(`Urgent notification '00000000-0000-4000-8000-00000000001a' for descendant '${child.id}'`)).toBe(true);
    expect(calls).toBe(2);
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
  }, 15000);
  it.each(['success', 'cancel-after-claim'] as const)('settles a real Oversight urgent queue tool through the retiring join barrier: %s', async (mode) => {
    const firstEntered = deferred();
    const successorEntered = deferred();
    const oldJoined = deferred();
    const releaseOldJoin = deferred();
    let calls = 0;
    let successorInput = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      calls += 1;
      if (calls === 1) firstEntered.resolve();
      else { successorInput = JSON.stringify(input.providerConversation.messages); successorEntered.resolve(); }
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, undefined, TEST_RUNTIME_WORKFLOWS);
    const child = h.cards.create({ type: 'goal', parent: 'project', title: 'Inactive planning target', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] });
    const originalJoin = ConversationLLMActor.prototype.join;
    let held = false;
    jest.spyOn(ConversationLLMActor.prototype, 'join').mockImplementation(async function (this: ConversationLLMActor) {
      const result = await originalJoin.call(this);
      if (!held && this.agentId === 'agent:planner:project') {
        held = true;
        oldJoined.resolve();
        await releaseOldJoin.promise;
      }
      return result;
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await firstEntered.promise;
    const prior = owner(h.supervisor);
    const interrupt = jest.spyOn(prior.processor, 'claimNodeInterruption');
    const enqueue = jest.spyOn(h.cards, 'enqueueNotification');
    const recordPreparation = jest.spyOn(h.cards, 'readRecordCurrent');
    const before = readConversation(h.projectRoot, 'agent:planner:project').sourceRows.length;
    const check = new AbortController();
    const assertEffectAdmission = jest.fn((signal: AbortSignal) => {
      if (signal !== check.signal) throw new Error('foreign check signal');
      signal.throwIfAborted();
    });
    const submit = jest.spyOn(h.supervisor, 'submitNotification');
    const port = createOversightNotificationPort({ oversight: { assertEffectAdmission }, cards: h.cards, workflows: TEST_RUNTIME_WORKFLOWS, submitNotification: h.supervisor.submitNotification.bind(h.supervisor) });
    const body = `Oversight urgent advice: ${mode}`;
    let settled = false;
    const tool = submitNotificationTool({ card_id: child.id, kind: 'finding', body, urgency: 'urgent' }, port, check.signal);
    void tool.then(() => { settled = true; }, () => { settled = true; });
    await oldJoined.promise;
    expect(assertEffectAdmission).toHaveBeenCalledTimes(1);
    expect(assertEffectAdmission).toHaveBeenCalledWith(check.signal);
    expect(submit).toHaveBeenCalledTimes(1);
    const note = enqueue.mock.calls[0]![1];
    expect(submit).toHaveBeenCalledWith(child.id, note, 'urgent', check.signal);
    expect(enqueue.mock.calls.map(([id]) => id)).toEqual([child.id, 'project']);
    expect(h.cards.read(child.id)?.pending_notifications).toEqual([note.id]);
    expect(h.cards.read('project')?.pending_notifications).toHaveLength(1);
    expect(h.cards.readPendingNotifications('project')[0]?.content).toContain(note.id);
    // Ordinal progression and the real LLM join prove the old consumer acknowledged;
    // the successor has not prepared records/session input or called the provider.
    expect(prior.processor.processPosition()).toMatchObject({ kind: 'node', executionOrdinal: 1 });
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(prior.urgentSettlement).not.toBeNull();
    if (mode === 'cancel-after-claim') check.abort(new Error('Oversight check cancelled after claim'));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(calls).toBe(1);
    expect(recordPreparation).not.toHaveBeenCalled();
    expect(h.supervisor.captureAutonomousExecutingLlmSnapshots().size).toBe(0);
    expect(readConversation(h.projectRoot, 'agent:planner:project').sourceRows.slice(before).map((row) => row.kind)).toEqual(['model_issue']);
    releaseOldJoin.resolve();
    await expect(tool).resolves.toEqual({ kind: 'succeeded', data: { queued: true, card_id: child.id, notification_id: note.id, body, interruption: { status: 'interrupted', stopped_card_ids: [] } } });
    await successorEntered.promise;
    expect(owner(h.supervisor)).toBe(prior);
    expect(prior.urgentSettlement).toBeNull();
    expect(successorInput).toContain(note.id);
    expect(successorInput).toContain(`descendant '${child.id}'`);
    expect(h.cards.read(child.id)?.pending_notifications).toEqual([note.id]);
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(interrupt).toHaveBeenCalledTimes(1);
    expect(calls).toBe(2);
    await expect(h.supervisor.stopProject()).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
  }, 15000);

  it.each(['failure', 'stop-takeover'] as const)('ends prepared Run recovery before ancestor work after child publication %s', async (mode) => {
    const childEntered = deferred();
    let childId = '';
    let calls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      calls += 1;
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-recovery-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, undefined, TEST_RUNTIME_WORKFLOWS);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    expect((await h.supervisor.startProject()).started).toBe(true);
    await childEntered.promise;
    await h.supervisor.stopProject();
    const ancestorRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const originalStop = h.cards.stopRunning.bind(h.cards);
    const failure = new Error('known child stopped-publication failure');
    let stopping: Promise<unknown> | null = null;
    const stop = jest.spyOn(h.cards, 'stopRunning').mockImplementation((id) => {
      if (mode === 'failure') throw failure;
      const result = originalStop(id);
      stopping = h.supervisor.stopProject();
      return result;
    });
    const activate = jest.spyOn(h.cards, 'activateStopped');
    if (mode === 'failure') await expect(h.supervisor.startProject()).rejects.toBe(failure);
    else await expect(h.supervisor.startProject()).rejects.toBeInstanceOf(RuntimeStoppedInterruption);
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    if (stopping) await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
    expect(stop.mock.calls.map(([id]) => id)).toEqual([childId]);
    expect(readConversation(h.projectRoot, 'agent:planner:project').sourceRows).toEqual(ancestorRows);
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)?.lifecycle.status).toBe(mode === 'failure' ? 'running' : 'stopped');
    expect(activate).not.toHaveBeenCalled();
    expect(calls).toBe(2);
    expect(h.supervisor.getActorRuntimeReadModel().cards).toEqual([]);
  }, 15000);

  it('settles a same-process Stop chain through prepared Run before launching project again', async () => {
    const childEntered = deferred();
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner' && ++plannerCalls === 1)
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      if (input.agentName === 'executor') childEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, undefined, TEST_RUNTIME_WORKFLOWS);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    await h.supervisor.start();
    expect((await h.supervisor.startProject()).started).toBe(true);
    await childEntered.promise;
    await h.supervisor.stopProject();
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const calls: string[] = [];
    const originalStop = h.cards.stopRunning.bind(h.cards);
    jest.spyOn(h.cards, 'stopRunning').mockImplementation((id) => { calls.push(id); return originalStop(id); });

    expect((await h.supervisor.startProject()).started).toBe(true);
    expect(calls).toEqual([childId, 'project']);
    expect(h.cards.read(childId)?.lifecycle.status).toBe('stopped');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    await h.supervisor.stopProject();
  });

  it('queues an active child target and returns its exact stopped result through the surviving parent', async () => {
    const childProviderEntered = deferred();
    const rootContinued = deferred();
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        rootContinued.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;

    const submitted = await h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-00000000001b', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
    expect(submitted).toEqual({ queued: true, cardId: childId, notificationId: '00000000-0000-4000-8000-00000000001b', interruption: { status: 'interrupted', stopped_card_ids: [childId] } });
    expect(h.cards.read(childId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.at(-1)?.change).toMatchObject({ change_reason: 'recovery stopped lifecycle' });
    expect(owner(h.supervisor)).toMatchObject({ cardId: 'project', terminalWinner: 'open', childCardId: null });
    await rootContinued.promise;
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const plannerRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const activationResult = plannerRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-child');
    expect(activationResult?.content).toContain('"outcome":"stopped"');
    expect(plannerRows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'activate-child')).toHaveLength(1);
    await h.supervisor.stopProject();
  });

  it('settles a targeted intermediate Planner and its active child deepest-first', async () => {
    const leafProviderEntered = deferred();
    const rootContinued = deferred();
    let goalId = '';
    let leafId = '';
    const plannerCalls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        const call = (plannerCalls.get(input.sessionId) ?? 0) + 1;
        plannerCalls.set(input.sessionId, call);
        if (call === 1) {
          const cardId = input.sessionId === 'agent:planner:project' ? goalId : leafId;
          return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `activate-${cardId}`, type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: cardId }) } }] }, provider_exchanges: [] };
        }
        if (input.sessionId !== 'agent:planner:project') throw new Error('Interrupted intermediate Planner continued after its stopped child settled.');
        rootContinued.resolve();
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      leafProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    goalId = h.cards.create({ type: 'goal', parent: 'project', title: 'Goal', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    leafId = h.cards.create({ type: 'code', parent: goalId, title: 'Leaf', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await leafProviderEntered.promise;

    await expect(h.supervisor.submitNotification(goalId, { id: '00000000-0000-4000-8000-00000000001c', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: goalId, notificationId: '00000000-0000-4000-8000-00000000001c', interruption: { status: 'interrupted', stopped_card_ids: [leafId, goalId] } });
    expect(h.cards.read(leafId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    expect(h.cards.read(goalId)).toMatchObject({ lifecycle: { status: 'stopped' } });
    expect(plannerCalls.get(`agent:planner:${goalId}`)).toBe(1);
    await rootContinued.promise;
    const rootRows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rootRows.find((row) => row.kind === 'tool_result' && row.tool_call_id === `activate-${goalId}`)?.content).toContain('"outcome":"stopped"');
    await h.supervisor.stopProject();
  });

  it('settles a persisted descendant tool call as rejected before execution when interruption wins before executor entry', async () => {
    let childId = '';
    let h!: ReturnType<typeof harness>;
    let armed = false;
    let submission: Promise<unknown> | null = null;
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'parked-write', type: 'function' as const, function: { name: 'write', arguments: JSON.stringify({ path: `record:///implementation.md?card=${childId}`, content: 'must not be written' }) } }] }, provider_exchanges: [] };
    });
    const changes = {
      conversationChanged(target: Parameters<NonNullable<ConversationFileContext['changes']>['conversationChanged']>[0]): void {
        if (!armed || target.session_id !== `agent:executor:${childId}`) return;
        const rows = readConversation(h.projectRoot, target.session_id).sourceRows;
        if (rows.at(-1)?.kind !== 'tool_call') return;
        armed = false;
        submission = h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-00000000001d', content: 'interrupt before tool entry', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
      },
      agentMembershipChanged(): void {},
    };
    h = harness(provider, changes);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    armed = true;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => submission !== null);
    await expect(submission).resolves.toMatchObject({ queued: true, interruption: { status: 'interrupted', stopped_card_ids: [childId] } });

    const rows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'parked-write');
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain('Tool execution was cancelled before entry.');
    expect(results[0]!.content).not.toContain('must not be written');
    await h.supervisor.stopProject();
  });

  it('suppresses stale captured urgency without interrupting after the awaited lease identity changes during enqueue', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const originalEnqueue = h.cards.enqueueNotification.bind(h.cards);
    let injected = false;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = originalEnqueue(...args);
      if (!injected && args[0] === childId) { injected = true; childOwner.parentRelationship!.invocation.markSettling(); }
      return result;
    });

    await expect(h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-00000000001e', content: 'retain only as queued context', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: childId, notificationId: '00000000-0000-4000-8000-00000000001e', interruption: { status: 'suppressed', reason: 'stale_owner', stopped_card_ids: [] } });
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.cards.read(childId)?.pending_notifications).toContain('00000000-0000-4000-8000-00000000001e');
    await h.supervisor.stopProject();
  });

  it('retains confirmed enqueue but suppresses interruption when Pause wins during enqueue', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const originalEnqueue = h.cards.enqueueNotification.bind(h.cards);
    let paused = false;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = originalEnqueue(...args);
      if (!paused && args[0] === childId) { paused = true; h.supervisor.pause(); }
      return result;
    });

    await expect(h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-00000000001f', content: 'queued before pause suppression', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).resolves.toEqual({ queued: true, cardId: childId, notificationId: '00000000-0000-4000-8000-00000000001f', interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    expect(interrupt).not.toHaveBeenCalled();
    expect(h.cards.read(childId)?.pending_notifications).toContain('00000000-0000-4000-8000-00000000001f');
    await h.supervisor.stopProject();
  });

  it('routes uncertain enqueue to the publication-fatal boundary before interruption or later effects', async () => {
    const childProviderEntered = deferred();
    let childId = '';
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId)!;
    const interrupt = jest.spyOn(childOwner.processor, 'interruptActivationGracefully');
    const stopRunning = jest.spyOn(h.cards, 'stopRunning');
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation(() => { throw new PublicationOutcomeUnknownError(); });

    await expect(h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000020', content: 'uncertain', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).rejects.toBe(testApplicationFatalDelivery);
    expect(interrupt).not.toHaveBeenCalled();
    expect(stopRunning).not.toHaveBeenCalled();
  });

  it('rejects urgent submission when interrupted descendant direct-scope containment fails before handoff', async () => {
    const childWaiting = deferred();
    let childId = '';
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      const call = (calls.get(input.sessionId) ?? 0) + 1;
      calls.set(input.sessionId, call);
      if (input.agentName === 'planner') {
        if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-process-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'start-held-process', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: 'held child process', wait: false }) } }] }, provider_exchanges: [] };
      childWaiting.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider, undefined, unverifiableProcessPlatform());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Process child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childWaiting.promise;

    await expect(h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000021', content: 'queued but not contained', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent')).rejects.toThrow('unverifiable: Process-group probe failed: process ownership cannot be verified');
    await waitFor(() => h.supervisor.getStatus().status === 'error');

    expect(h.cards.read(childId)?.pending_notifications).toContain('00000000-0000-4000-8000-000000000021');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.some((version) => version.change?.change_reason === 'recovery stopped lifecycle')).toBe(false);
    expect(owner(h.supervisor).childCardId).toBe(childId);
  });

  it('lets a runtime halt take over an already claimed interruption without stopped publication or target continuation', async () => {
    const childProviderEntered = deferred();
    const interruptionJoinEntered = deferred();
    const releaseInterruptionJoin = deferred();
    let childId = '';
    let plannerCalls = 0;
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      if (input.agentName === 'planner') {
        plannerCalls += 1;
        if (plannerCalls === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        throw new Error('Target Planner continued after runtime halt takeover.');
      }
      childProviderEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await childProviderEntered.promise;
    const childOwner = (h.supervisor as unknown as { activationOwners: Map<string, CardActivationOwner> }).activationOwners.get(childId);
    if (!childOwner) throw new Error('Expected child activation owner.');
    const originalJoin = childOwner.processor.joinActivation.bind(childOwner.processor);
    jest.spyOn(childOwner.processor, 'joinActivation').mockImplementation(async () => {
      const joined = originalJoin();
      interruptionJoinEntered.resolve();
      await releaseInterruptionJoin.promise;
      return joined;
    });

    const submission = h.supervisor.submitNotification(childId, { id: '00000000-0000-4000-8000-000000000022', content: 'urgent correction', created_at: '2026-09-09T00:00:02.000Z', source: 'test' }, 'urgent');
    await interruptionJoinEntered.promise;
    const stopping = h.supervisor.stopProject();
    releaseInterruptionJoin.resolve();
    await expect(submission).resolves.toMatchObject({ queued: true, notificationId: '00000000-0000-4000-8000-000000000022', interruption: { status: 'suppressed', reason: 'runtime_ineligible', stopped_card_ids: [] } });
    await expect(stopping).resolves.toEqual({ status: 'stopped', contained: true });
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions(childId);
    if (versions.kind !== 'found') throw new Error('Expected child version stream.');
    expect(versions.value.some((version) => version.change?.change_reason === 'recovery stopped lifecycle')).toBe(false);
    expect(plannerCalls).toBe(1);
  });

  it('distinguishes normal root enqueue from completed active-root interruption', async () => {
    const providerEntered = deferred();
    const provider = scriptedAdmissionProvider(async (_input, signal) => {
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    await expect(h.supervisor.submitNotification('project', { id: '00000000-0000-4000-8000-000000000023', content: 'normal', created_at: '2026-09-09T00:00:01.000Z' }, 'normal')).resolves.toMatchObject({ queued: true, interruption: { status: 'not_requested' } });
    await expect(h.supervisor.submitNotification('project', { id: '00000000-0000-4000-8000-000000000024', content: 'urgent', created_at: '2026-09-09T00:00:02.000Z' }, 'urgent')).resolves.toMatchObject({ queued: true, interruption: { status: 'interrupted', stopped_card_ids: ['project'] } });
    await h.supervisor.stopProject();
  });

  it('retains a card notification caller through synchronous Stop and settles its known receipt without continuation', async () => {
    const resultPublished = deferred();
    const releaseConsumer = deferred();
    const originalSettlement = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settlement = originalSettlement.apply(this, args);
      return settlement.then(async (facts) => {
        resultPublished.resolve();
        await releaseConsumer.promise;
        return facts;
      });
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      if (calls !== 1) throw new Error('Planner continued after retained notification settlement.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-stop', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'known queued context', urgency: 'normal' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => stopping !== null);
    await resultPublished.promise;

    let stopSettled = false;
    void stopping!.finally(() => { stopSettled = true; });
    await Promise.resolve();
    expect(stopSettled).toBe(false);

    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'notify-before-stop')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-stop');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(calls).toBe(1);
    releaseConsumer.resolve();
    await expect(stopping!).resolves.toEqual({ status: 'stopped', contained: true });
  });

  it.each(['stop', 'close'] as const)('retains an entered card binder notification when %s wins during the target read', async (takeover) => {
    let h!: ReturnType<typeof harness>;
    let armed = false;
    let containment: Promise<unknown> | null = null;
    let calls = 0;
    const changes = {
      conversationChanged(target: Parameters<NonNullable<ConversationFileContext['changes']>['conversationChanged']>[0]): void {
        if (target.session_id !== 'agent:planner:project') return;
        if (readConversation(h.projectRoot, target.session_id).sourceRows.at(-1)?.kind === 'tool_call') armed = true;
      },
      agentMembershipChanged(): void {},
    };
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      if (calls !== 1) throw new Error('Provider continued after runtime containment.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'entered-notification', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'entered before containment', urgency: 'normal' }) } }] }, provider_exchanges: [] };
    });
    h = harness(provider, changes);
    const originalRead = h.cards.read.bind(h.cards);
    jest.spyOn(h.cards, 'read').mockImplementation((id) => {
      if (armed && id === 'project' && containment === null) {
        armed = false;
        containment = takeover === 'stop' ? h.supervisor.stopProject() : h.supervisor.cleanupForApplicationStop();
        void containment.catch(() => undefined);
        expect(owner(h.supervisor)).toMatchObject({ phase: 'active', terminalWinner: 'open' });
      }
      return originalRead(id);
    });
    expect((await h.supervisor.startProject()).started).toBe(true);
    await waitFor(() => containment !== null);
    await expect(containment!).resolves.not.toThrow();
    const queue = h.cards.read('project')?.pending_notifications;
    expect(queue).toHaveLength(1);
    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'entered-notification')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'entered-notification');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(results[0]?.content).toContain(`"notification_id":"${queue![0]!}"`);
    expect(calls).toBe(1);
    expect(h.supervisor.getStatus().status).toBe('stopped');
  });

  it('keeps a matching queued receipt while the complete Stop owns later retained-consumer failure', async () => {
    const cleanupFailure = new Error('retained notification consumer cleanup failed');
    const resultPublished = deferred();
    const originalSettlement = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      return originalSettlement.apply(this, args).then((facts) => {
        resultPublished.resolve();
        throw cleanupFailure;
      });
    });
    let calls = 0;
    const provider = scriptedAdmissionProvider(async () => {
      calls += 1;
      if (calls !== 1) throw new Error('Planner continued after retained notification settlement.');
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-failed-stop', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'truth survives failed cleanup', urgency: 'normal' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await resultPublished.promise;
    await expect(stopping!).rejects.toBe(cleanupFailure);

    const rows = readConversation(h.projectRoot, 'agent:planner:project').sourceRows;
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-failed-stop');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    expect(h.supervisor.getStatus().status).toBe('error');
    expect(calls).toBe(1);
  });

  it('keeps a matching queued receipt while real direct-scope process containment fails Stop', async () => {
    let childId = '';
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      const call = (calls.get(input.sessionId) ?? 0) + 1;
      calls.set(input.sessionId, call);
      if (input.agentName === 'planner') {
        if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'activate-notifying-child', type: 'function' as const, function: { name: 'activate_card', arguments: JSON.stringify({ card_id: childId }) } }] }, provider_exchanges: [] };
        return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      if (call === 1) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'held-process', type: 'function' as const, function: { name: 'run_command', arguments: JSON.stringify({ command: 'held test process', wait: false }) } }] }, provider_exchanges: [] };
      if (call === 2) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'notify-before-process-failure', type: 'function' as const, function: { name: 'queue_notification', arguments: JSON.stringify({ card_id: 'project', kind: 'correction', body: 'queued before containment failure', urgency: 'normal' }) } }] }, provider_exchanges: [] };
      throw new Error('Executor continued after retained notification settlement.');
    });
    const h = harness(provider, undefined, unverifiableProcessPlatform(), workflowsWithExecutorNotification());
    childId = h.cards.create({ type: 'code', parent: 'project', title: 'Notifying process child', bootstrap_content: 'Brief', priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [] }).id;
    const enqueue = h.cards.enqueueNotification.bind(h.cards);
    let stopping: Promise<unknown> | null = null;
    jest.spyOn(h.cards, 'enqueueNotification').mockImplementation((...args) => {
      const result = enqueue(...args);
      stopping = h.supervisor.stopProject();
      void stopping.catch(() => undefined);
      return result;
    });

    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await waitFor(() => stopping !== null);
    await expect(stopping!).rejects.toThrow('unverifiable: Process-group probe failed: process ownership cannot be verified');

    const rows = readConversation(h.projectRoot, `agent:executor:${childId}`).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'notify-before-process-failure')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'notify-before-process-failure');
    expect(results).toHaveLength(1);
    expect(results[0]?.content).toContain('"queued":true');
    const queued = h.cards.read('project')?.pending_notifications;
    expect(queued).toHaveLength(1);
    expect(results[0]?.content).toContain(`"notification_id":"${queued![0]!}"`);
    expect(h.supervisor.getStatus().status).toBe('error');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    expect(h.cards.read(childId)?.lifecycle.status).toBe('running');
    expect(calls.get(`agent:executor:${childId}`)).toBe(2);
  });

  it('rejects after the real result claim while durable state is still running and performs no card append', async () => {
    const held = deferred();
    const entered = deferred();
    const original = ConversationLLMActor.prototype.settleToolResultWithoutContinuation;
    jest.spyOn(ConversationLLMActor.prototype, 'settleToolResultWithoutContinuation').mockImplementation(function (this: ConversationLLMActor, ...args) {
      const settled = original.apply(this, args);
      entered.resolve();
      return settled.then(async (facts) => { await held.promise; return facts; });
    });
    let turn = 0;
    const provider = scriptedAdmissionProvider(async () => {
      turn += 1;
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${turn}`, type: 'function' as const, function: turn === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'done' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await entered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('result');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions('project');
    const bytes = readFileSync(cardHeadFile(h.projectRoot, 'project'));
    const enqueue = jest.spyOn(h.cards, 'enqueueNotification');
    expect(h.supervisor.notifyCard('project', notification())).toEqual({ ok: false, reason: 'activation_closed', cardId: 'project' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.cards.listCardVersions('project')).toEqual(versions);
    expect(readFileSync(cardHeadFile(h.projectRoot, 'project'))).toEqual(bytes);
    held.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.cards.read('project')?.lifecycle.status).toBe('done');
  });

  it('rejects after the real cancellation claim while durable state is still running and performs no card append', async () => {
    const providerEntered = deferred();
    const provider = scriptedAdmissionProvider(async (_input: unknown, signal: AbortSignal) => {
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const held = deferred();
    const joinEntered = deferred();
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    const processor = owner(h.supervisor).processor;
    const originalJoin = processor.joinActivation.bind(processor);
    jest.spyOn(processor, 'joinActivation').mockImplementation(() => {
      const joined = originalJoin();
      joinEntered.resolve();
      return joined.then(async (value) => { await held.promise; return value; });
    });
    const cancellation = h.supervisor.cancelCard('project', 'cancel test');
    await joinEntered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('cancel');
    expect(h.cards.read('project')?.lifecycle.status).toBe('running');
    const versions = h.cards.listCardVersions('project');
    const bytes = readFileSync(cardHeadFile(h.projectRoot, 'project'));
    const enqueue = jest.spyOn(h.cards, 'enqueueNotification');
    expect(h.supervisor.notifyCard('project', notification())).toEqual({ ok: false, reason: 'activation_closed', cardId: 'project' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(h.cards.listCardVersions('project')).toEqual(versions);
    expect(readFileSync(cardHeadFile(h.projectRoot, 'project'))).toEqual(bytes);
    held.resolve();
    await expect(cancellation).resolves.toEqual({ card_id: 'project', status: 'cancelled', cancelled_card_ids: ['project'] });
    expect(h.cards.read('project')?.lifecycle.status).toBe('cancelled');
  });

  it('delivers an open-admission notification through accepted emit-result arbitration before a later result settles', async () => {
    const terminalCandidateHeld = deferred();
    const terminalCandidateRequested = deferred();
    const observedInputs: string[] = [];
    let turn = 0;
    const provider = scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      turn += 1;
      if (turn === 2) { terminalCandidateRequested.resolve(); await terminalCandidateHeld.promise; }
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `call-${turn}`, type: 'function' as const, function: turn === 1
        ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: 'done' }) }
        : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'complete_direct', summary: 'done' }) } }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await terminalCandidateRequested.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('open');
    expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-000000000025', content: 'distinct admitted context', created_at: '2026-09-09T00:00:02.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000025' });
    terminalCandidateHeld.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(turn).toBe(3);
    expect(observedInputs[2]).toContain('distinct admitted context');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'done' }, pending_notifications: [] });
  });

  it('keeps Planner notifications from Reviewer and conditionally repeats accepted review through the Planner handler', async () => {
    const reviewApprovalRequested = deferred();
    const releaseReviewApproval = deferred();
    const observed = new Map<string, string[]>();
    const calls = new Map<string, number>();
    const provider = scriptedAdmissionProvider(async (input) => {
      const agent = input.agentName;
      const call = (calls.get(agent) ?? 0) + 1;
      calls.set(agent, call);
      const inputs = observed.get(agent) ?? [];
      inputs.push(JSON.stringify(input));
      observed.set(agent, inputs);
      if (agent === 'reviewer' && call === 2) { reviewApprovalRequested.resolve(); await releaseReviewApproval.promise; }
      const definition = agent === 'planner'
        ? call % 2 === 1
          ? { name: 'write', arguments: JSON.stringify({ path: 'record:///status.md?card=project', content: `planner status ${call}` }) }
          : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'admit_review', summary: `planner review request ${call}` }) }
        : call % 2 === 1
          ? { name: 'write', arguments: JSON.stringify({ path: 'record:///review.md?card=project', content: `review evidence ${call}` }) }
          : { name: 'emit_result', arguments: JSON.stringify({ outcome: 'approved', summary: `review approved ${call}` }) };
      return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `${agent}-${call}`, type: 'function' as const, function: definition }] }, provider_exchanges: [] };
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await reviewApprovalRequested.promise;
    expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-000000000026', content: 'planner designated context', created_at: '2026-09-09T00:00:02.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000026' });
    const closeRecord = h.cards.closeRecord.bind(h.cards);
    let injectedDuringClose = false;
    jest.spyOn(h.cards, 'closeRecord').mockImplementation((...args) => {
      const result = closeRecord(...args);
      if (!injectedDuringClose && args[1] === 'review.md' && h.cards.read('project')!.pending_notifications.length > 0) {
        injectedDuringClose = true;
        expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-000000000027', content: 'context admitted during accepted record close', created_at: '2026-09-09T00:00:03.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000027' });
      }
      return result;
    });
    releaseReviewApproval.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(calls).toEqual(new Map([['planner', 4], ['reviewer', 6]]));
    expect(observed.get('reviewer')!.join('\n')).not.toContain('planner designated context');
    expect(observed.get('planner')![2]).toContain('planner designated context');
    expect(observed.get('planner')![2]).toContain('context admitted during accepted record close');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'done' }, pending_notifications: [] });
  });

  it('allows preclaim enqueue and intentionally clears it through cancellation without delivery', async () => {
    const providerEntered = deferred();
    const observedInputs: string[] = [];
    const provider = scriptedAdmissionProvider(async (input, signal) => {
      observedInputs.push(JSON.stringify(input));
      providerEntered.resolve();
      return await new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(owner(h.supervisor).terminalWinner).toBe('open');
    expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-000000000028', content: 'not delivered before cancel', created_at: '2026-09-09T00:00:03.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000028' });
    expect(h.cards.read('project')?.pending_notifications).toHaveLength(1);
    await expect(h.supervisor.cancelCard('project', 'cancel after admission')).resolves.toMatchObject({ status: 'cancelled' });
    expect(h.cards.read('project')?.pending_notifications).toEqual([]);
    expect(observedInputs.join('\n')).not.toContain('not delivered before cancel');
  });

  it('allows preclaim enqueue and intentionally clears it on ordinary execution failure without delivery', async () => {
    const providerEntered = deferred();
    const release = deferred();
    const observedInputs: string[] = [];
    const provider = scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      providerEntered.resolve();
      await release.promise;
      throw new Error('ordinary execution failure');
    });
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-000000000029', content: 'not delivered before failure', created_at: '2026-09-09T00:00:04.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-000000000029' });
    release.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'failed' }, pending_notifications: [] });
    expect(observedInputs.join('\n')).not.toContain('not delivered before failure');
  });

  it('allows preclaim enqueue and intentionally clears it on a real content-policy BLOCKED outcome without delivery', async () => {
    const providerEntered = deferred();
    const release = deferred();
    const observedInputs: string[] = [];
    let turn = 0;
    const provider = { ...scriptedAdmissionProvider(async (input) => {
      observedInputs.push(JSON.stringify(input));
      turn += 1;
      if (turn === 1) { providerEntered.resolve(); await release.promise; }
      throw refusal(input.inputId, turn === 1 ? 'first refusal' : 'second refusal');
    }), projectProviderExchanges() {} };
    const h = harness(provider);
    const started = await h.supervisor.startProject();
    if (!started.started) throw new Error('Expected project start.');
    await providerEntered.promise;
    expect(h.supervisor.notifyCard('project', { id: '00000000-0000-4000-8000-00000000002a', content: 'not delivered before blocked', created_at: '2026-09-09T00:00:05.000Z' })).toEqual({ ok: true, notificationId: '00000000-0000-4000-8000-00000000002a' });
    release.resolve();
    await waitFor(() => h.supervisor.getStatus().status === 'stopped');
    expect(turn).toBe(2);
    expect(h.cards.read('project')).toMatchObject({ lifecycle: { status: 'blocked' }, pending_notifications: [] });
    expect(observedInputs.join('\n')).not.toContain('not delivered before blocked');
  });
});

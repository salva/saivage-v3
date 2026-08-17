import {afterEach,describe,expect,it,jest} from '@jest/globals';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {InvocationService,type InvocationRequest} from '../../src/agents/invocation-service.js';
import {MemoryCandidateAvailability} from '../../src/agents/candidate-availability.js';
import type {Candidate} from '../../src/contracts/provider-candidate.js';
import {NO_FRESHNESS_EFFECTS} from '../../src/application/freshness-effects.js';
import {invocationProviderRegistry} from '../helpers/invocation-provider-fixture.js';
import {preparedInvocationContextFixture} from '../helpers/prepared-invocation-context.js';
import {prepareCompaction} from '../../src/runtime/actors/compaction/compactor.js';

const first:Candidate={provider:'first',account:null,model:'m1'};
const second:Candidate={provider:'second',account:null,model:'m2'};
const roots:string[]=[];
afterEach(()=>{jest.restoreAllMocks();while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

function refusal():Response{const body=JSON.stringify({error:{code:'content_filter',message:'content policy refusal'}});return new Response(body,{status:400,headers:{'content-type':'application/json'}});}
function service(availability=new MemoryCandidateAvailability()):InvocationService{const projectRoot=mkdtempSync(join(tmpdir(),'content-policy-route-'));roots.push(projectRoot);return new InvocationService({projectRoot,registry:invocationProviderRegistry([first,second]),candidateAvailability:availability,freshness:NO_FRESHNESS_EFFECTS});}
function request(routePass:InvocationRequest['routePass'],signal?:AbortSignal):InvocationRequest{return {inputId:'00000000-0000-4000-8000-000000000001',agentName:'planner',sessionId:'agent:planner:project',...preparedInvocationContextFixture(),providerConversation:{sourceSessionId:'agent:planner:project',messages:[]},modelParams:{temperature:0},preparedCompaction:prepareCompaction({input_budget_tokens:1000,trigger_fraction:.8,completion_reserve_fraction:.2,merge_line_fraction:.3,summary_line_fraction:.5,escalate_merge_line_fraction:.4,escalate_summary_line_fraction:.6,snap:'compact_straddler'},'system',[],100),capabilityRequest:{},routePass,abortSignal:signal};}
async function ordinary(value:InvocationRequest,availability?:MemoryCandidateAvailability){const instance=service(availability);const admission=instance.preparePrimaryRequestAdmission(value);if(admission.kind!=='admitted')throw new Error('fixture not admitted');return instance.executeAdmittedWithRecovery(admission);}
async function pinned(value:InvocationRequest,availability?:MemoryCandidateAvailability){const instance=service(availability);if(value.routePass.kind!=='pinned-content-policy-retry')throw new Error('fixture not pinned');const preflight=instance.preflightPinnedContentPolicyRequest(value,value.routePass.candidate);if(preflight.kind!=='admitted')throw new Error('fixture not admitted');return instance.executePinnedContentPolicyRequest(preflight);}

describe('content-policy route passes',()=>{
  it('terminates ordinary routing at the refusing candidate without availability effects',async()=>{
    const availability=new MemoryCandidateAvailability();const isAvailable=jest.spyOn(availability,'isAvailable');const markFailed=jest.spyOn(availability,'markFailed');const calls:string[]=[];
    jest.spyOn(globalThis,'fetch').mockImplementation(async(input)=>{calls.push(new URL(String(input)).hostname);return refusal();});
    await expect(ordinary(request({kind:'ordinary',candidateChain:[first,second]}),availability)).rejects.toMatchObject({failure_phase:'provider_attempt',failure:{kind:'content_policy'},candidate:first});
    expect(calls).toEqual(['first.example.test']);expect(isAvailable).toHaveBeenCalled();expect(markFailed).not.toHaveBeenCalled();
  });

  it('makes one pinned call without any availability read/write or recovery',async()=>{
    const availability=new MemoryCandidateAvailability();const reads=jest.spyOn(availability,'isAvailable');const writes=jest.spyOn(availability,'markFailed');const successes=jest.spyOn(availability,'markSucceeded');const fetch=jest.spyOn(globalThis,'fetch').mockResolvedValue(refusal());
    await expect(pinned(request({kind:'pinned-content-policy-retry',candidate:first}),availability)).rejects.toMatchObject({failure_phase:'provider_attempt',failure:{kind:'content_policy'},candidate:first,provider_exchanges:[{attempt_index:0}]});
    expect(fetch).toHaveBeenCalledTimes(1);expect(reads).not.toHaveBeenCalled();expect(writes).not.toHaveBeenCalled();expect(successes).not.toHaveBeenCalled();
  });

  it('reports observed pre-transport cancellation as a final zero-call pinned failure',async()=>{
    const controller=new AbortController();controller.abort(new Error('cancel before transport'));const fetch=jest.spyOn(globalThis,'fetch');
    await expect(pinned(request({kind:'pinned-content-policy-retry',candidate:first},controller.signal))).rejects.toMatchObject({failure_phase:'pre_provider',provider_exchanges:[],candidate:first});
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured pinned candidate before transport',async()=>{
    const fetch=jest.spyOn(globalThis,'fetch');const invalid={provider:'first',account:null,model:'not-configured'};
    await expect(pinned(request({kind:'pinned-content-policy-retry',candidate:invalid}))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

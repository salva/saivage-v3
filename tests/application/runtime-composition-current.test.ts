import { afterEach,describe,expect,it,jest } from '@jest/globals';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { createInvocationServiceProvider,invocationRequest } from '../../src/application/micro-actor-runtime-api-factory.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import { bindRuntimeWorkflows } from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { createEventLog } from '../../src/observability/index.js';
import { initProjectTree,TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';

const roots:string[]=[];afterEach(()=>{jest.restoreAllMocks();while(roots.length)rmSync(roots.pop()!,{recursive:true,force:true});});

describe('current runtime composition',()=>{
  it('maps only an already bound candidate chain through the invocation provider',async()=>{const invokeWithRecovery=jest.fn<InvocationService['invokeWithRecovery']>(async()=>({result:{kind:'message',content:'done'},provider_exchanges:[]}));const service={invokeWithRecovery,projectProviderExchanges:jest.fn()} as unknown as InvocationService;const provider=createInvocationServiceProvider(service);const signal=new AbortController().signal;const candidateChain=[{provider:'test',account:null,model:'test-model'}];const input:LlmInvocationInput={inputId:'turn',agentId:'agent:planner:project',agentName:'planner',sessionId:'agent:planner:project',systemPrompt:'plan',providerConversation:{sourceSessionId:'agent:planner:project',messages:[]},tools:[],terminalToolNames:['emit_result'],modelParams:{maxTokens:100},capabilityRequest:{requiresTools:true},candidateChain,episodeContext:{}};const request=invocationRequest(input,signal);expect(request.candidateChain).toEqual(candidateChain);await provider.completeTurn(input,signal);expect(invokeWithRecovery).toHaveBeenCalledWith(request);expect(()=>invocationRequest({...input,candidateChain:undefined},signal)).toThrow(/no bound candidate chain/);});

  it('composes runtime and Analyst from one bound workflow artifact without rebinding it',()=>{const projectRoot=mkdtempSync(join(tmpdir(),'runtime-composition-current-'));roots.push(projectRoot);initProjectTree(projectRoot);const config=TEST_SAIVAGE_CONFIG;const registry=new ProviderRegistry(config);const workflows=bindRuntimeWorkflows(TEST_WORKFLOWS,new ModelRouter(config,registry));const processRegistry=new ManagedProcessGroupRegistry();const runtimeRoot=processRegistry.createContainerScope(processRegistry.rootScope,'runtime');const analystRoot=processRegistry.createContainerScope(processRegistry.rootScope,'analyst');const processRunner=new ProcessRunner(projectRoot,processRegistry);const freshness={runtimeChanged:jest.fn(),cardProjectionChanged:jest.fn(),agentsChanged:jest.fn(),conversationChanged:jest.fn(),timelineChanged:jest.fn()};const app=createRuntimeApplication({projectRoot,processIdentity:{pid:42,startedAt:'2026-07-22T00:00:00.000Z'},config,workflows,providerRegistry:registry,configAuthority:createTestConfigAuthority(projectRoot),eventLogger:createEventLog(projectRoot),cardStore:new CardService(projectRoot,workflows,freshness),freshness,processRunner,runtimeProcessRootScope:runtimeRoot,analystProcessRootScope:analystRoot,mcpToolInvocation:unusedMcpToolInvocation});expect(app.runtimeApi).toBe(app.runtimeControl);expect(app.analystSessionId).toBe('agent:analyst:global');expect(app.analystRuntime.getAvailableToolNames()).toEqual([...workflows.analyst.tools]);expect(workflows.candidateChains.get('planner')).toEqual([expect.objectContaining({provider:'test',model:'test-model'})]);});
});

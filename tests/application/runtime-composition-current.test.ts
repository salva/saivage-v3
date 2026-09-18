import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { createInvocationServiceProvider } from '../../src/application/invocation-service-provider.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { ProviderRegistry } from '../../src/agents/provider.js';
import { ModelRouter } from '../../src/agents/model-router.js';
import {
  bindRuntimeWorkflows,
  compileProjectWorkflows,
} from '../../src/runtime/card-process/card-process-config.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { createTestConfigAuthority } from '../helpers/project-config.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { AnalystRuntime } from '../../src/agents/analyst-api.js';
import { effectiveSaivageConfigSchema } from '../../src/schemas/saivage-config.js';
import type { AgentMembershipFreshnessTarget } from '../../src/application/freshness-effects.js';
import type { OversightClock } from '../../src/application/project-oversight.js';

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

class DeterministicOversightClock implements OversightClock {
  now = 0;
  readonly wall = '2026-09-14T00:00:00.000Z';
  #next = 1;
  readonly timers = new Map<number, { at: number; callback: () => void }>();
  monotonicNow = () => this.now;
  wallNow = () => new Date(Date.parse(this.wall) + this.now).toISOString();
  setTimeout = (callback: () => void, delay: number) => { const id = this.#next++; this.timers.set(id, { at: this.now + delay, callback }); return id; };
  clearTimeout = (handle: unknown) => { this.timers.delete(handle as number); };
  advance(ms: number) { this.now += ms; for (;;) { const due = [...this.timers].find(([, timer]) => timer.at <= this.now); if (!due) return; this.timers.delete(due[0]); due[1].callback(); } }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 2)); }
  throw new Error('condition not reached');
}

function toolCalls(...calls: Array<{ id: string; name: string }>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: calls.map(({ id, name }) => ({
              id,
              type: 'function',
              function: { name, arguments: '{}' },
            })),
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('current runtime composition', () => {
  it('copies a required route pass and forwards separate admitted provider boundaries', async () => {
    const admittedExecution = jest.fn<InvocationService['executeAdmittedWithRecovery']>(
      async () => ({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] }),
    );
    const prepareAdmission = jest.fn<InvocationService['preparePrimaryRequestAdmission']>(() => ({
      kind: 'admitted',
      routePass: {
        kind: 'ordinary',
        candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
      },
      candidates: [],
      executionAuthority: {
        kind: 'ordinary',
        admittedCandidateIdentities: [{ provider: 'test', account: null, model: 'test-model' }],
        admittedCandidateIdentitiesSha256: '0'.repeat(64),
      },
      bindings: {} as never,
      execution: {} as never,
    }));
    const projectProviderExchanges = jest.fn<InvocationService['projectProviderExchanges']>();
    const service = {
      preparePrimaryRequestAdmission: prepareAdmission,
      executeAdmittedWithRecovery: admittedExecution,
      projectProviderExchanges,
    } as unknown as InvocationService;
    const provider = createInvocationServiceProvider(service);
    const signal = new AbortController().signal;
    const candidateChain = [{ provider: 'test', account: null, model: 'test-model' }];
    const input: LlmInvocationInput = {
      inputId: 'turn',
      agentId: 'agent:planner:project',
      agentName: 'planner',
      sessionId: 'agent:planner:project',
      systemPrompt: 'plan',
      providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] },
      tools: [],
      compiledToolContracts: [],
      terminalToolNames: ['emit_result'],
      modelParams: { temperature: 0, maxTokens: 100 },
      capabilityRequest: { requiresTools: true },
      routePass: { kind: 'ordinary', candidateChain },
      episodeContext: {},
    };
    const admission = provider.preparePrimaryRequestAdmission(input as never, signal);
    const request = prepareAdmission.mock.calls[0]![0];
    expect(request.routePass).toEqual({ kind: 'ordinary', candidateChain });
    expect(request.routePass).not.toBe(input.routePass);
    await provider.executeAdmittedWithRecovery(admission as never, signal);
    expect(admittedExecution).toHaveBeenCalledWith(admission, signal);
    const context = { assistantOutputIds: [], terminalConversationOutputId: null };
    provider.projectProviderExchanges!('agent:planner:project', 'turn', [], context);
    expect(projectProviderExchanges).toHaveBeenCalledWith(
      'agent:planner:project',
      'turn',
      [],
      context,
    );
  });

  it('composes runtime and Analyst from one bound workflow artifact without rebinding it', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-composition-current-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const config = TEST_SAIVAGE_CONFIG;
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(TEST_WORKFLOWS, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime');
    const analystRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst');
    const processRunner = new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort);
    const freshness = {
      runtimeChanged: jest.fn(),
      cardProjectionChanged: jest.fn(),
      agentMembershipChanged: jest.fn(),
      conversationChanged: jest.fn(),
      llmExchangeChanged: jest.fn(),
    };
    const app = createRuntimeApplication({
      projectRoot,
      processIdentity: { pid: 42, startedAt: '2026-07-22T00:00:00.000Z' },
      config,
      workflows,
      providerRegistry: registry,
      configAuthority: createTestConfigAuthority(projectRoot),
      cardStore: new CardService(projectRoot, workflows, freshness),
      freshness,
      processRunner,
      runtimeProcessRootScope: runtimeRoot,
      analystProcessRootScope: analystRoot,
      mcpToolInvocation: unusedMcpToolInvocation,
      restartCapability: { available: false },
      fatalPort: testApplicationFatalPort,
      onOversightOwnerFailure(error) { throw error; },
      analystSessionId: 'agent:analyst:global',
    });
    expect(Object.keys(app).filter((key) => key.startsWith('runtime'))).toEqual(['runtimeApi']);
    expect(app.analystSessionId).toBe('agent:analyst:global');
    expect(app.analystRuntime.getAvailableToolNames()).toEqual([
      ...workflows.agentBindings.get('analyst')!.toolSet.names,
    ]);
    expect(workflows.agentBindings.get('planner')?.candidateChain).toEqual([
      expect.objectContaining({ provider: 'test', model: 'test-model' }),
    ]);
  });

  it('captures an instantiated Analyst session without constructing Analyst runtime on a read', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-composition-capture-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const config = TEST_SAIVAGE_CONFIG;
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(TEST_WORKFLOWS, new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime');
    const analystRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst');
    const processRunner = new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort);
    const freshness = {
      runtimeChanged: jest.fn(),
      cardProjectionChanged: jest.fn(),
      agentMembershipChanged: jest.fn(),
      conversationChanged: jest.fn(),
      llmExchangeChanged: jest.fn(),
    };
    const snapshot = jest
      .spyOn(AnalystRuntime.prototype, 'executingLlmSnapshot')
      .mockReturnValue({ sessionId: 'agent:analyst:global' } as never);
    const app = createRuntimeApplication({
      projectRoot,
      processIdentity: { pid: 42, startedAt: '2026-07-22T00:00:00.000Z' },
      config,
      workflows,
      providerRegistry: registry,
      configAuthority: createTestConfigAuthority(projectRoot),
      cardStore: new CardService(projectRoot, workflows, freshness),
      freshness,
      processRunner,
      runtimeProcessRootScope: runtimeRoot,
      analystProcessRootScope: analystRoot,
      mcpToolInvocation: unusedMcpToolInvocation,
      restartCapability: { available: false },
      fatalPort: testApplicationFatalPort,
      onOversightOwnerFailure(error) { throw error; },
      analystSessionId: 'agent:analyst:global',
    });
    expect(app.captureExecutingLlmSnapshots().size).toBe(0);
    expect(snapshot).not.toHaveBeenCalled();
    void app.analystRuntime;
    expect([...app.captureExecutingLlmSnapshots().keys()]).toEqual(['agent:analyst:global']);
    expect(snapshot).toHaveBeenCalledTimes(1);
  });

  it('composes transition-driven Oversight concurrently with Analyst and autonomous card execution', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-composition-oversight-e2e-'));
    roots.push(projectRoot); initProjectTree(projectRoot);
    const config = structuredClone(TEST_SAIVAGE_CONFIG); config.oversight.interval_seconds = 1;
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(compileProjectWorkflows(config), new ModelRouter(registry), registry, config.compaction.context_utilization_fraction);
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime');
    const analystRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst');
    const processRunner = new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort);
    const clock = new DeterministicOversightClock();
    const requests: string[] = [];
    const freshness = { runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentMembershipChanged: jest.fn(), conversationChanged: jest.fn(), llmExchangeChanged: jest.fn() };
    const cardStore=new CardService(projectRoot,workflows,freshness);
    const goal=cardStore.create({type:'goal',parent:'project',title:'deep planning scope',bootstrap_content:'plan',priority:0,urgency:'normal',created_by:'planner',depends_on:[]});
    const leaf=cardStore.create({type:'code',parent:goal.id,title:'deep active child',bootstrap_content:'execute',priority:0,urgency:'normal',created_by:'planner',depends_on:[]});
    jest.spyOn(globalThis, 'fetch').mockImplementation(async (request, init) => {
      requests.push(String(init?.body ?? (request instanceof Request ? await request.clone().text() : '')));
      const activationTarget=requests.length===1?goal.id:requests.length===2?leaf.id:null;
      if(activationTarget)return new Response(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:`activate-${activationTarget}`,type:'function',function:{name:'activate_card',arguments:JSON.stringify({card_id:activationTarget})}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:1,completion_tokens:1,total_tokens:2}}),{status:200,headers:{'content-type':'application/json'}});
      const signal = init?.signal ?? (request instanceof Request ? request.signal : undefined);
      return await new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const app = createRuntimeApplication({projectRoot,processIdentity:{pid:42,startedAt:clock.wall},config,workflows,providerRegistry:registry,configAuthority:createTestConfigAuthority(projectRoot),cardStore,freshness,processRunner,runtimeProcessRootScope:runtimeRoot,analystProcessRootScope:analystRoot,mcpToolInvocation:unusedMcpToolInvocation,restartCapability:{available:false},fatalPort:testApplicationFatalPort,analystSessionId:'agent:analyst:global',oversightClock:clock,onOversightOwnerFailure(error){throw error;}});
    await app.runtimeApi.start();
    clock.advance(10_000);
    expect(requests).toHaveLength(0);
    expect(app.getOversightStatus()).toMatchObject({state:'unavailable',eligibility_reason:'stopped',last_attempt:null});
    const started = await app.runtimeApi.startProject(); expect(started.started).toBe(true);
    await waitUntil(() => requests.length === 3);
    expect(app.captureExecutingLlmSnapshots().has(`agent:executor:${leaf.id}`)).toBe(true);
    const analyst = app.analystRuntime.submit({userContent:'Inspect independently while project work runs.'});
    await waitUntil(() => requests.length === 4);
    clock.advance(999); expect(requests).toHaveLength(4);
    clock.advance(1); await waitUntil(() => requests.length === 5);
    expect(app.getOversightStatus().state).toBe('checking');
    expect([...app.captureExecutingLlmSnapshots().keys()]).toEqual(expect.arrayContaining(['agent:analyst:global','agent:oversight:global','agent:planner:project',`agent:planner:${goal.id}`,`agent:executor:${leaf.id}`]));
    expect(requests.some((body) => body.includes('Saivage Oversight'))).toBe(true);
    expect(requests.some((body) => body.includes('Saivage Analyst'))).toBe(true);
    app.closeRuntimeAdmission();app.closeAnalystAdmission();app.closeOversightAdmission();processRunner.closeLaunchAdmission();
    await Promise.all([app.cleanupRuntimeForApplicationStop(),app.cleanupAnalystForApplicationStop(),app.cleanupOversightForApplicationStop()]);
    await expect(analyst).rejects.toBeDefined();
  });

  it('publishes the global membership target at Analyst projection start and end', async () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'runtime-composition-analyst-freshness-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const config = effectiveSaivageConfigSchema.parse({
      ...structuredClone(TEST_SAIVAGE_CONFIG),
      providers: {
        test: {
          models: ['test-model'],
          baseUrl: 'https://provider.example.test/v1',
          apiKey: 'synthetic-test-key',
          capabilities: {
            transportProtocol: 'openai-chat-completions',
            toolsMode: 'native',
            exclusiveToolChoiceSupport: 'native',
            contextWindowTokens: 100_000,
            maxOutputTokens: 10_000,
          },
        },
      },
      compaction: {
        ...structuredClone(TEST_SAIVAGE_CONFIG.compaction),
        context_utilization_fraction: 0.8,
      },
    });
    const registry = new ProviderRegistry(config);
    const workflows = bindRuntimeWorkflows(
      compileProjectWorkflows(config),
      new ModelRouter(registry),
      registry,
      config.compaction.context_utilization_fraction,
    );
    const processRegistry = new ManagedProcessGroupRegistry();
    const runtimeRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime');
    const analystRoot = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst');
    const processRunner = new ProcessRunner(projectRoot, processRegistry, testApplicationFatalPort);
    const observations: Array<{ target: AgentMembershipFreshnessTarget; live: boolean }> = [];
    let app!: ReturnType<typeof createRuntimeApplication>;
    const freshness = {
      runtimeChanged: jest.fn(),
      cardProjectionChanged: jest.fn(),
      agentMembershipChanged: jest.fn((target: AgentMembershipFreshnessTarget) =>
        observations.push({
          target,
          live: app.captureExecutingLlmSnapshots().has('agent:analyst:global'),
        }),
      ),
      conversationChanged: jest.fn(),
      llmExchangeChanged: jest.fn(),
    };
    app = createRuntimeApplication({
      projectRoot,
      processIdentity: { pid: 42, startedAt: '2026-07-22T00:00:00.000Z' },
      config,
      workflows,
      providerRegistry: registry,
      configAuthority: createTestConfigAuthority(projectRoot),
      cardStore: new CardService(projectRoot, workflows, freshness),
      freshness,
      processRunner,
      runtimeProcessRootScope: runtimeRoot,
      analystProcessRootScope: analystRoot,
      mcpToolInvocation: unusedMcpToolInvocation,
      restartCapability: { available: false },
      fatalPort: testApplicationFatalPort,
      onOversightOwnerFailure(error) { throw error; },
      analystSessionId: 'agent:analyst:global',
    });
    let resolveFirst!: (response: Response) => void;
    let firstRequested!: () => void;
    const requested = new Promise<void>((resolve) => {
      firstRequested = resolve;
    });
    const firstResponse = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    jest
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => {
        firstRequested();
        return firstResponse;
      })
      .mockResolvedValueOnce(
        toolCalls(
          { id: 'unsupported-a', name: 'list_cards' },
          { id: 'unsupported-b', name: 'list_cards' },
        ),
      );

    const turn = app.analystRuntime.submit({ userContent: 'List project cards.' });
    await requested;
    expect([...app.captureExecutingLlmSnapshots().keys()]).toEqual(['agent:analyst:global']);
    resolveFirst(toolCalls({ id: 'list-project', name: 'list_cards' }));
    await turn;

    expect(app.captureExecutingLlmSnapshots().size).toBe(0);
    expect(new Set(observations.map(({ target }) => target.scope))).toEqual(
      new Set(['global-session']),
    );
    expect(
      new Set(
        observations.map(({ target }) =>
          target.scope === 'global-session' ? target.sessionId : target.cardId,
        ),
      ),
    ).toEqual(new Set(['agent:analyst:global']));
    expect(observations.some(({ live }) => live)).toBe(true);
    expect(observations.some(({ live }) => !live)).toBe(true);
  });
});

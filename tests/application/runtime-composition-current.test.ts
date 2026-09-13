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

const roots: string[] = [];
afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

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
      analystSessionId: 'agent:analyst:global',
    });
    expect(app.captureExecutingLlmSnapshots().size).toBe(0);
    expect(snapshot).not.toHaveBeenCalled();
    void app.analystRuntime;
    expect([...app.captureExecutingLlmSnapshots().keys()]).toEqual(['agent:analyst:global']);
    expect(snapshot).toHaveBeenCalledTimes(1);
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

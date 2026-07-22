import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/schemas/saivage-config.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { createRuntimeApplication } from '../../src/application/runtime-composition.js';
import { createInvocationServiceProvider, invocationRequest } from '../../src/application/micro-actor-runtime-api-factory.js';
import { CardService } from '../../src/cards/card-service.js';
import { createEventLog } from '../../src/observability/index.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';
import { DEFAULT_CARD_PROCESSES } from '../../src/agents/default-card-processes.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { agentMessageSchema } from '../../src/schemas/index.js';
import { ManagedProcessGroupRegistry } from '../../src/runtime/managed-process-group-registry.js';
import { ProcessRunner } from '../../src/runtime/process-runner.js';
import { unusedMcpToolInvocation } from '../helpers/llm-test-helpers.js';
import { dataPropertyGraphContains } from '../helpers/data-property-graph.js';
import { prepareCompaction } from '../../src/runtime/actors/compaction/compactor.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function config(candidate = { provider: 'test', account: null as string | null, model: 'org/summary/model' }) {
  return saivageConfigSchema.parse({
    models: { default: ['org/summary/model'], max_tokens: { analyst: 2000 } },
    providers: { test: { models: ['org/summary/model'] } },
    compaction: { enabled: true, input_budget_tokens: 30000, summarizer_candidate: candidate },
    card_processes: DEFAULT_CARD_PROCESSES,
  });
}

function services(selectedConfig = config()) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-composition-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const freshness = { runtimeChanged: jest.fn(), cardProjectionChanged: jest.fn(), agentsChanged: jest.fn(), conversationChanged: jest.fn(), timelineChanged: jest.fn() };
  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
  const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
  return {
    projectRoot, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }, config: selectedConfig, configAuthority: testConfigAuthority(projectRoot),
    eventLogger: createEventLog(projectRoot, freshness.timelineChanged),
    cardStore: new CardService(projectRoot, freshness), freshness,
    processRegistry, processRunner: new ProcessRunner(projectRoot, processRegistry), runtimeProcessRootScope, analystProcessRootScope, mcpToolInvocation: unusedMcpToolInvocation,
  };
}

function invocationInput(overrides: Record<string, unknown> = {}): LlmInvocationInput {
  return {
    inputId: 'turn-1',
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt: 'plan',
    providerConversation: { sourceSessionId: 'planner:project', messages: [] },
    tools: [],
    terminalToolNames: ['report_done'],
    modelParams: { temperature: 0.2, maxTokens: 1000 },
    capabilityRequest: { requiresTools: true },
    episodeContext: { cardId: 'project' },
    ...overrides,
  };
}

describe('runtime compaction composition', () => {
  it('maps LlmInvocationInput through the production invocation service provider', async () => {
    const invokeWithRecovery = jest.fn<InvocationService['invokeWithRecovery']>(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
    const invocationService = { invokeWithRecovery, projectProviderExchanges: jest.fn() } as unknown as InvocationService;
    const provider = createInvocationServiceProvider(invocationService);
    const signal = new AbortController().signal;
    const input = invocationInput();
    const request = invocationRequest(input, signal);

    expect(request).toEqual({
      inputId: 'turn-1',
      role: 'planner',
      sessionId: 'planner:project',
      systemPrompt: 'plan',
      providerConversation: { sourceSessionId: 'planner:project', messages: [] },
      tools: [],
      terminalToolNames: ['report_done'],
      modelParams: { temperature: 0.2, maxTokens: 1000 },
      capabilityRequest: { requiresTools: true },
      abortSignal: signal,
    });
    await expect(provider.completeTurn(input, signal)).resolves.toEqual({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] });
    expect(invokeWithRecovery).toHaveBeenCalledWith(request);
  });

  it('forwards prepared compaction without adding an ordinary maxTokens authority', async () => {
    const invokeWithRecovery = jest.fn<InvocationService['invokeWithRecovery']>(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
    const invocationService = { invokeWithRecovery, projectProviderExchanges: jest.fn() } as unknown as InvocationService;
    const provider = createInvocationServiceProvider(invocationService);
    const preparedCompaction = prepareCompaction({ input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler' }, 'plan', []);
    const signal = new AbortController().signal;
    const input = invocationInput({ modelParams: {}, preparedCompaction });
    const request = invocationRequest(input, signal);

    expect(request).toEqual(expect.objectContaining({ modelParams: {}, preparedCompaction }));
    expect(request.capabilityRequest).not.toHaveProperty('requestedCompletionTokens');
    await provider.completeTurn(input, signal);
    expect(invokeWithRecovery).toHaveBeenCalledWith(request);
  });

  it('composes direct conversation freshness effects', () => {
    const selected = services();
    createRuntimeApplication(selected);
    const timestamp = '2026-07-19T00:00:00.000Z';
    const sessions = ['analyst:global', 'planner:project', 'reviewer:project', 'executor:project'] as const;
    const rows = sessions.map((sessionId, index) => agentMessageSchema.parse(index === 0
      ? { id: `composed-entry-${index}`, session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${String(index).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }
      : { id: `composed-entry-${index}`, session_id: sessionId, role: 'user', kind: 'text', content: 'private content is not an event field', round_id: `r-user-${String(index).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }));

    for (const row of rows) appendConversationBatch({ projectRoot: selected.projectRoot, changes: selected.freshness }, [row]);

    expect(selected.freshness.conversationChanged.mock.calls.map(([sessionId]) => sessionId)).toEqual(rows.map((row) => row.session_id));
    expect(selected.freshness.agentsChanged).toHaveBeenCalledTimes(rows.length);
  });

  it('rejects a non-emitted candidate before runtime or actor side effects', () => {
    const invalid = config({ provider: 'test', account: null, model: 'missing/model' });
    const selected = services(invalid);
    const directScope = jest.spyOn(selected.processRunner, 'createDirectScope');
    expect(() => createRuntimeApplication(selected)).toThrow(/compaction\.summarizer_candidate/);
    expect(directScope).not.toHaveBeenCalled();
    expect(selected.freshness.runtimeChanged).not.toHaveBeenCalled();
    expect(selected.freshness.agentsChanged).not.toHaveBeenCalled();
  });

  it('composes real runtime mechanics and routes analyst requests through the production provider', async () => {
    const invoke = jest.spyOn(InvocationService.prototype, 'invokeWithRecovery').mockResolvedValue({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] });
    jest.spyOn(InvocationService.prototype, 'projectProviderExchanges').mockImplementation(() => undefined);
    const selected = services();
    const createDirectScope = jest.spyOn(selected.processRunner, 'createDirectScope');
    const closeScope = jest.spyOn(selected.processRunner, 'closeScope');
    const app = createRuntimeApplication(selected);

    expect(app.runtimeApi).toBe(app.runtimeControl);
    const runtimeAuthority = new Set<unknown>([selected.processRunner, selected.runtimeProcessRootScope]);
    expect(dataPropertyGraphContains(app.runtimeApi, runtimeAuthority)).toBe(false);
    expect(dataPropertyGraphContains(app.runtimeControl, runtimeAuthority)).toBe(false);
    expect(app.runtimeApi.getStatus()).toEqual({ status: 'stopped', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' });
    expect(app.processRunner).toBe(selected.processRunner);
    expect(app.analystRuntime.getAvailableToolNames()).toContain('run_command');
    const catalogScope = createDirectScope.mock.results.at(-1)!.value;
    expect(createDirectScope).toHaveBeenLastCalledWith(selected.analystProcessRootScope, 'analyst-tool-catalog', 'operator_session');
    expect(closeScope).toHaveBeenCalledWith(catalogScope);
    for (let round = 0; round < 80 && !invoke.mock.calls.some(([request]) => Object.hasOwn(request, 'candidateChain')); round += 1) {
      await app.analystRuntime.submit({ userContent: `establish compactable analyst history ${round} ${'x'.repeat(1_000)}` });
    }
    await app.analystRuntime.submit({ userContent: 'route through the ordinary analyst role' });
    expect(dataPropertyGraphContains(app.analystRuntime, new Set([selected.processRegistry, selected.processRunner, selected.runtimeProcessRootScope, selected.analystProcessRootScope]))).toBe(false);
    expect(Reflect.ownKeys(app.analystRuntime)).not.toEqual(expect.arrayContaining(['args', 'runtimeDeps', 'session', 'admissionOpen']));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ role: 'analyst', sessionId: 'analyst:global', preparedCompaction: expect.any(Object) }));
    expect(invoke.mock.calls.some(([request]) => !Object.hasOwn(request, 'candidateChain'))).toBe(true);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ candidateChain: [{ provider: 'test', account: null, model: 'org/summary/model' }] }));
  });

  it('rejects an incompatible effective role override before runtime actor side effects', () => {
    const selected = services();
    const directScope = jest.spyOn(selected.processRunner, 'createDirectScope');
    const path = join(selected.projectRoot, '.saivage', 'config', 'prompts', 'goal', 'planner.md');
    mkdirSync(join(selected.projectRoot, '.saivage', 'config', 'prompts', 'goal'), { recursive: true });
    writeFileSync(path, 'Old override: use emit_result with status done, blocked, or failed.');
    expect(() => createRuntimeApplication(selected)).toThrow(new RegExp(`goal\\/planner.*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(directScope).not.toHaveBeenCalled();
    expect(selected.freshness.runtimeChanged).not.toHaveBeenCalled();
    expect(selected.freshness.agentsChanged).not.toHaveBeenCalled();
  });
});

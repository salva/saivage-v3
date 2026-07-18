import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { createRuntimeApplication, type RuntimeApiFactoryDeps } from '../../src/application/runtime-composition.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { createErrorLog, createEventLog } from '../../src/observability/index.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { initProjectTree, testConfigAuthority } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function config(candidate = { provider: 'test', account: null as string | null, model: 'org/summary/model' }) {
  return saivageConfigSchema.parse({
    models: { default: ['org/summary/model'], max_tokens: { analyst: 2000 } },
    providers: { test: { models: ['org/summary/model'] } },
    compaction: { enabled: true, input_budget_tokens: 10000, summarizer_candidate: candidate },
  });
}

function services(runtimeApiFactory: (deps: RuntimeApiFactoryDeps) => any, selectedConfig = config()) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-composition-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const eventBus = new EventBus();
  const readModelChanges = new ReadModelChangeBroadcaster();
  const appLogs = { projectRoot, changes: readModelChanges };
  return {
    projectRoot, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }, config: selectedConfig, configAuthority: testConfigAuthority(projectRoot), eventBus,
    eventLogger: createEventLog(projectRoot, appLogs, eventBus), errorLogger: createErrorLog(projectRoot, appLogs, eventBus), appLogs,
    cardStore: new CardService(projectRoot, eventBus, readModelChanges), readModelChanges, runtimeApiFactory,
  };
}

function mechanics() {
  return { start: async () => undefined, startProject: async () => ({ runtime: null, status: 'stopped', started: false, stopped: true }), pause: async () => ({ status: 'stopped' }), resume: async () => ({ status: 'stopped' }), stopProject: async () => ({ status: 'stopped', contained: false }), notifyCard: () => ({ ok: false }), cancelCard: async () => { throw new Error('unused'); }, subscribe: () => ({ unsubscribe() {} }), getStatus: () => ({ status: 'stopped', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }), getRuntimeState: () => null, getActorRuntimeReadModel: () => ({ pauseMode: 'idle', cards: [] }), captureAutonomousExecutingLlmSnapshots: () => [], closeApplicationAdmission() {}, cleanupForApplicationStop: async () => undefined } as any;
}

describe('runtime compaction composition', () => {
  it('rejects a non-emitted candidate before an injected runtime factory is invoked', () => {
    const runtimeApiFactory = jest.fn(() => mechanics());
    const invalid = config({ provider: 'test', account: null, model: 'missing/model' });
    expect(() => createRuntimeApplication(services(runtimeApiFactory, invalid))).toThrow(/compaction\.summarizer_candidate/);
    expect(runtimeApiFactory).not.toHaveBeenCalled();
  });

  it('passes identity-free policy and routes summaries through exactly the validated structured candidate', async () => {
    let deps!: RuntimeApiFactoryDeps;
    const runtimeApiFactory = jest.fn((value: RuntimeApiFactoryDeps) => { deps = value; return mechanics(); });
    const invoke = jest.spyOn(InvocationService.prototype, 'invokeWithRecovery').mockResolvedValue({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [] });
    const project = jest.spyOn(InvocationService.prototype, 'projectProviderExchanges').mockImplementation(() => undefined);
    const app = createRuntimeApplication(services(runtimeApiFactory));

    expect(runtimeApiFactory).toHaveBeenCalledTimes(1);
    expect(deps.compactionPolicy).toEqual({ input_budget_tokens: 10000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim' });
    expect(app.analystDeps.compactionPolicy).toBe(deps.compactionPolicy);
    expect(app.analystDeps.compactor).toBe(deps.compactor);
    expect(app.analystDeps.summarizerProvider).toBe(deps.summarizerProvider);
    expect(app.analystDeps.compactor).toEqual({ shouldCompact: expect.any(Function), compact: expect.any(Function) });
    expect(deps).not.toHaveProperty('config');
    expect(deps).not.toHaveProperty('summarizer_candidate');
    await app.analystRuntime.submit({ userContent: 'route through the ordinary analyst role' });
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ role: 'analyst', sessionId: 'analyst:global', preparedCompaction: expect.any(Object) }));
    expect(invoke.mock.calls[0]![0]).not.toHaveProperty('candidateChain');
    const input: LlmInvocationInput = { inputId: 'id', agentId: 'llm:compaction-summarizer', role: 'analyst', sessionId: 'summary:test', systemPrompt: 'summarize', providerConversation: { sourceSessionId: null, messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 2000 }, capabilityRequest: {}, episodeContext: { compaction: true } };
    await deps.summarizerProvider.completeTurn(input, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ candidateChain: [{ provider: 'test', account: null, model: 'org/summary/model' }] }));
    deps.summarizerProvider.projectProviderExchanges('summary:test', 'id', [], []);
    expect(project).toHaveBeenCalledWith('summary:test', 'id', [], []);
  });
});

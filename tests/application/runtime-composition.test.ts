import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { InvocationService } from '../../src/agents/invocation-service.js';
import { createRuntimeApplication, type RuntimeApiFactoryDeps } from '../../src/application/runtime-composition.js';
import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
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

const roots: string[] = [];
afterEach(() => { jest.restoreAllMocks(); while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function config(candidate = { provider: 'test', account: null as string | null, model: 'org/summary/model' }) {
  return saivageConfigSchema.parse({
    models: { default: ['org/summary/model'], max_tokens: { analyst: 2000 } },
    providers: { test: { models: ['org/summary/model'] } },
    compaction: { enabled: true, input_budget_tokens: 10000, summarizer_candidate: candidate },
    card_processes: DEFAULT_CARD_PROCESSES,
  });
}

function services(runtimeApiFactory: (deps: RuntimeApiFactoryDeps) => any, selectedConfig = config()) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-runtime-composition-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const eventBus = new EventBus();
  const readModelChanges = new ReadModelChangeBroadcaster();
  const appLogs = { projectRoot };
  const processRegistry = new ManagedProcessGroupRegistry();
  const runtimeProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'runtime-cards');
  const analystProcessRootScope = processRegistry.createContainerScope(processRegistry.rootScope, 'analyst-sessions');
  return {
    projectRoot, processIdentity: { pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }, config: selectedConfig, configAuthority: testConfigAuthority(projectRoot), eventBus,
    eventLogger: createEventLog(projectRoot, appLogs), appLogs,
    cardStore: new CardService(projectRoot, eventBus, readModelChanges), readModelChanges, runtimeApiFactory,
    processRegistry, processRunner: new ProcessRunner(projectRoot, processRegistry), runtimeProcessRootScope, analystProcessRootScope, mcpToolInvocation: unusedMcpToolInvocation,
  };
}

function mechanics() {
  return { start: async () => undefined, startProject: async () => ({ runtime: null, status: 'stopped', started: false, stopped: true }), pause: async () => ({ status: 'stopped' }), resume: async () => ({ status: 'stopped' }), stopProject: async () => ({ status: 'stopped', contained: false }), notifyCard: () => ({ ok: false }), cancelCard: async () => { throw new Error('unused'); }, subscribe: () => ({ unsubscribe() {} }), getStatus: () => ({ status: 'stopped', currentCardId: null, pid: 4242, startedAt: '2026-07-18T00:00:00.000Z' }), getRuntimeState: () => null, getActorRuntimeReadModel: () => ({ pauseMode: 'idle', cards: [] }), captureAutonomousExecutingLlmSnapshots: () => [], closeApplicationAdmission() {}, cleanupForApplicationStop: async () => undefined } as any;
}

describe('runtime compaction composition', () => {
  it('composes the narrow append observer into the unchanged conversation_changed event payload', () => {
    let deps!: RuntimeApiFactoryDeps;
    const runtimeApiFactory = jest.fn((value: RuntimeApiFactoryDeps) => { deps = value; return mechanics(); });
    const selected = services(runtimeApiFactory);
    const events: unknown[] = [];
    selected.eventBus.subscribe('conversation_changed', (event) => { events.push(event.payload); });
    createRuntimeApplication(selected);
    const timestamp = '2026-07-19T00:00:00.000Z';
    const sessions = ['analyst:global', 'planner:project', 'reviewer:project', 'executor:project'] as const;
    const rows = sessions.map((sessionId, index) => agentMessageSchema.parse(index === 0
      ? { id: `composed-entry-${index}`, session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'analyst', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${String(index).padStart(32, '0')}`, message_index: 0, block_index: 0, timestamp }
      : { id: `composed-entry-${index}`, session_id: sessionId, role: 'user', kind: 'text', content: 'private content is not an event field', round_id: `r-user-${String(index).padStart(32, '0')}`, message_index: 1, block_index: 0, timestamp }));

    for (const row of rows) appendConversationBatch(deps.conversations, [row]);

    expect(events).toEqual(rows.map((row) => ({ session_id: row.session_id, mutation: 'entry_appended', message_id: row.id, message_kind: row.kind, role: row.role, message_timestamp: timestamp })));
  });

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
    const selected = services(runtimeApiFactory);
    const createDirectScope = jest.spyOn(selected.processRunner, 'createDirectScope');
    const closeScope = jest.spyOn(selected.processRunner, 'closeScope');
    const app = createRuntimeApplication(selected);

    expect(runtimeApiFactory).toHaveBeenCalledTimes(1);
    expect(app.runtimeApi).toBe(app.runtimeControl);
    expect(app.runtimeApi).not.toBe(runtimeApiFactory.mock.results[0]!.value);
    const mechanicsValue = runtimeApiFactory.mock.results[0]!.value;
    const runtimeAuthority = new Set<unknown>([mechanicsValue, deps, selected.processRunner, selected.runtimeProcessRootScope]);
    expect(dataPropertyGraphContains(app.runtimeApi, runtimeAuthority)).toBe(false);
    expect(dataPropertyGraphContains(app.runtimeControl, runtimeAuthority)).toBe(false);
    expect([...deps.cardProcesses.planning.definition.states.get('node:plan')!.on.keys()].filter((event) => event.startsWith('result:'))).toEqual(['result:complete_direct', 'result:admit_review', 'result:blocked', 'result:failed']);
    expect(deps.processPrompts.get('goal', 'plan' as any)).toContain('current planning step');
    expect(deps.compactionPolicy).toEqual({ input_budget_tokens: 10000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim' });
    expect(app.processRunner).toBe(selected.processRunner);
    expect(deps.processRunner).toBe(selected.processRunner);
    expect(deps.mcpToolInvocation).toBe(selected.mcpToolInvocation);
    expect(deps).not.toHaveProperty('config');
    expect(deps).not.toHaveProperty('summarizer_candidate');
    expect(deps).not.toHaveProperty('appLogs');
    expect(app.analystRuntime.getAvailableToolNames()).toContain('run_command');
    const catalogScope = createDirectScope.mock.results.at(-1)!.value;
    expect(createDirectScope).toHaveBeenLastCalledWith(selected.analystProcessRootScope, 'analyst-tool-catalog', 'operator_session');
    expect(closeScope).toHaveBeenCalledWith(catalogScope);
    await app.analystRuntime.submit({ userContent: 'route through the ordinary analyst role' });
    expect(dataPropertyGraphContains(app.analystRuntime, new Set([selected.processRegistry, selected.processRunner, selected.runtimeProcessRootScope, selected.analystProcessRootScope]))).toBe(false);
    expect(Reflect.ownKeys(app.analystRuntime)).not.toEqual(expect.arrayContaining(['args', 'runtimeDeps', 'session', 'admissionOpen']));
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ role: 'analyst', sessionId: 'analyst:global', preparedCompaction: expect.any(Object) }));
    expect(invoke.mock.calls[0]![0]).not.toHaveProperty('candidateChain');
    const input: LlmInvocationInput = { inputId: 'id', agentId: 'llm:compaction-summarizer', role: 'analyst', sessionId: 'summary:test', systemPrompt: 'summarize', providerConversation: { sourceSessionId: null, messages: [] }, tools: [], terminalToolNames: [], modelParams: { maxTokens: 2000 }, capabilityRequest: {}, episodeContext: { compaction: true } };
    await deps.summarizerProvider.completeTurn(input, new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ candidateChain: [{ provider: 'test', account: null, model: 'org/summary/model' }] }));
    deps.summarizerProvider.projectProviderExchanges('summary:test', 'id', [], []);
    expect(project).toHaveBeenCalledWith('summary:test', 'id', [], []);
  });

  it('rejects an incompatible effective role override before runtime actor construction', () => {
    const runtimeApiFactory = jest.fn(() => mechanics());
    const selected = services(runtimeApiFactory);
    const path = join(selected.projectRoot, '.saivage', 'config', 'prompts', 'goal', 'planner.md');
    mkdirSync(join(selected.projectRoot, '.saivage', 'config', 'prompts', 'goal'), { recursive: true });
    writeFileSync(path, 'Old override: use emit_result with status done, blocked, or failed.');
    expect(() => createRuntimeApplication(selected)).toThrow(new RegExp(`goal\\/planner.*${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(runtimeApiFactory).not.toHaveBeenCalled();
  });
});

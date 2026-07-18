import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AnalystRuntime } from '../../src/agents/analyst-handler.js';
import { saivageConfigSchema } from '../../src/agents/config-schema.js';
import { CardService } from '../../src/cards/card-service.js';
import { EventBus } from '../../src/events/index.js';
import { readConversation } from '../../src/persistence/conversation-file.js';
import type { LlmInvocationInput, PreparedLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { RuntimeInterventionBinding } from '../../src/application/intervention-readiness.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { testAppLogs } from '../helpers/app-logs.js';
import { createTestProcessRunner } from '../helpers/test-process-runner.js';
import { createTestPromptTemplateRegistry } from '../helpers/prompt-template-registry.js';
import { compact, prepareCompaction, shouldCompact } from '../../src/runtime/actors/compaction/compactor.js';
import { classifyConversationRounds } from '../../src/runtime/actors/compaction/round-classifier.js';
import { providerConversationProjection } from '../../src/runtime/actors/conversation-session.js';
import { validateConversationRows } from '../../src/contracts/conversation-compaction.js';
import { ProviderTurnFailure } from '../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('Analyst continuation compaction safety', () => {
  it('exposes only the current Analyst operation through provider work, success, failure, cancellation, and an exact external wait', async () => {
    const unusedSummary = async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] });
    let runtime!: AnalystRuntime;
    let releaseProvider!: (value: any) => void;
    const providerGate = new Promise((resolve) => { releaseProvider = resolve; });
    const primary = jest.fn(async () => {
      expect(runtime.executingLlmSnapshot()).toMatchObject({ sessionId: 'analyst:global', role: 'analyst', activity: { mode: 'active' } });
      return providerGate;
    });
    ({ runtime } = harness(primary, unusedSummary));
    expect(runtime.executingLlmSnapshot()).toBeNull();
    const success = runtime.submit({ userContent: 'success' });
    await waitUntil(() => runtime.executingLlmSnapshot() !== null);
    releaseProvider({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] });
    await success;
    expect(runtime.executingLlmSnapshot()).toBeNull();

    const failedHarness = harness(jest.fn(async () => { throw new Error('provider failed'); }), unusedSummary);
    await failedHarness.runtime.submit({ userContent: 'failure' });
    expect(failedHarness.runtime.executingLlmSnapshot()).toBeNull();

    const cancelledHarness = harness(jest.fn(async (_input: LlmInvocationInput, signal: AbortSignal) => new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))), unusedSummary);
    const cancelled = cancelledHarness.runtime.submit({ userContent: 'cancel' });
    await waitUntil(() => cancelledHarness.runtime.executingLlmSnapshot() !== null);
    expect(cancelledHarness.runtime.cancel('operator')).toBe(true);
    await cancelled;
    expect(cancelledHarness.runtime.executingLlmSnapshot()).toBeNull();

    let releaseFetch!: (response: Response) => void;
    const fetchGate = new Promise<Response>((resolve) => { releaseFetch = resolve; });
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockReturnValue(fetchGate);
    try {
      let calls = 0;
      const waitingHarness = harness(jest.fn(async () => {
        calls += 1;
        return calls === 1
          ? { result: { kind: 'tool_calls', tool_calls: [{ id: 'web-call', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://93.184.216.34","metadata_only":true}' } }] }, provider_exchanges: [] }
          : { result: { kind: 'message', content: 'fetched' }, provider_exchanges: [] };
      }), unusedSummary, jest.fn(), false);
      const waiting = waitingHarness.runtime.submit({ userContent: 'fetch' });
      await waitUntil(() => waitingHarness.runtime.executingLlmSnapshot()?.activity.mode === 'waiting');
      expect(waitingHarness.runtime.executingLlmSnapshot()).toMatchObject({ activity: { mode: 'waiting', barrier: { kind: 'external', toolCallId: 'web-call', toolName: 'webfetch' } } });
      releaseFetch(new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } }));
      await waiting;
      expect(waitingHarness.runtime.executingLlmSnapshot()).toBeNull();
    } finally { fetchSpy.mockRestore(); }
  });

  it('produces exact marker-first rounds, retains one preparation over continuations, and compacts producer history', async () => {
    const captured: LlmInvocationInput[] = [];
    const primary = jest.fn(async (input: LlmInvocationInput) => {
      captured.push(input);
      if (captured.length <= 2) {
        const toolName = input.tools[captured.length - 1]!.function.name;
        return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: `tool-${captured.length}`, type: 'function' as const, function: { name: toolName, arguments: '{}' } }] }, provider_exchanges: [] };
      }
      return { result: { kind: 'message' as const, content: `answer ${captured.length}` }, provider_exchanges: [] };
    });
    const summary = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'fixed summary' }, provider_exchanges: [] }));
    const { runtime, projectRoot, summarizerProvider } = harness(primary, summary);

    const first = await runtime.submit({ userContent: 'first operator question' });
    expect(first.toolInvocations).toHaveLength(2);
    const firstPrepared = captured[0]!.preparedCompaction;
    expect(captured.slice(0, 3).every((input) => input.preparedCompaction === firstPrepared)).toBe(true);
    expect(captured.slice(0, 3).every((input) => input.systemPrompt === captured[0]!.systemPrompt && input.tools === captured[0]!.tools)).toBe(true);

    await runtime.submit({ userContent: 'second operator question', workspaceContext: { view: 'cards', entityId: 'project', refinement: null } });
    expect(captured[3]!.preparedCompaction).not.toBe(firstPrepared);
    const before = readConversation(projectRoot, 'analyst:global');
    const classified = classifyConversationRounds('analyst:global', before.sourceRows);
    expect(classified.preamble).toEqual([]);
    expect(classified.rounds).toHaveLength(2);
    expect(classified.rounds[0]!.rows[0]!.message.kind).toBe('activity');
    expect(classified.rounds[1]!.rows[0]!.message.kind).toBe('activity');
    for (const round of classified.rounds) {
      const marker = JSON.parse(round.activation_marker.message.content);
      expect(marker).toEqual({ event: 'activation_open', role: 'analyst', input_id: expect.any(String), timestamp: round.activation_marker.message.timestamp });
      expect(marker).not.toHaveProperty('card_id');
    }
    expect(countContent(before.sourceRows, 'first operator question')).toBe(1);
    expect(countContent(before.sourceRows, 'second operator question')).toBe(1);

    const latest = captured[3] as PreparedLlmInvocationInput;
    const roomy = prepareCompaction({ input_budget_tokens: 20480, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'keep_straddler_verbatim' }, latest.systemPrompt, latest.tools, 4096);
    const result = await compact({
      strategy: 'preventive',
      conversations: { projectRoot },
      input: { ...latest, providerConversation: providerConversationProjection(before), preparedCompaction: { ...roomy, normalTailBudget: 0, normalMiddleBudget: 0, escalatedTailBudget: 0, escalatedMiddleBudget: 0, triggerMessageThreshold: 100_000, snap: 'compact_straddler' } },
      summarizerProvider,
      signal: new AbortController().signal,
    });
    expect(result.kind).toBe('compacted');
    expect(summary).toHaveBeenCalled();
    const after = readConversation(projectRoot, 'analyst:global');
    expect(after.latestCompaction?.groups[0]?.rounds[0]?.label).toBe(classified.rounds[0]!.round_id);
    expect(after.latestCompaction?.groups.flatMap((group) => group.rounds).every((round) => round.complete)).toBe(true);
    expect(providerConversationProjection(after).sourceSessionId).toBe('analyst:global');
  });

  it.each([
    ['pre-cutover rows', [{ role: 'user', kind: 'text', content: 'old row' }]],
    ['wrong role marker', [{ role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-07-17T00:00:00.000Z' }) }]],
    ['analyst marker with card', [{ role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'analyst', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-07-17T00:00:00.000Z' }) }]],
  ])('rejects %s without compatibility inference', (_label, partials) => {
    const rows = partials.map((partial, index) => ({ id: `bad-${index}`, session_id: 'analyst:global', round_id: 'r-user-00000000000000000000000000000000', message_index: index, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z', ...partial })) as any;
    expect(() => validateConversationRows('analyst:global', rows)).toThrow();
  });

  it('never replays an accepted tool when its continuation receives one same-input context retry', async () => {
    const calls: LlmInvocationInput[] = [];
    const projectProviderExchanges = jest.fn();
    const primary = jest.fn(async (input: LlmInvocationInput) => {
      calls.push(input);
      if (calls.length === 1) return { result: { kind: 'message' as const, content: 'baseline' }, provider_exchanges: [] };
      if (calls.length === 2) return { result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'accepted-tool', type: 'function' as const, function: { name: input.tools[0]!.function.name, arguments: '{}' } }] }, provider_exchanges: [] };
      if (calls.length === 3) throw contextFailure(input);
      return { result: { kind: 'message' as const, content: 'done after retry' }, provider_exchanges: [exchange(input.inputId, 'ok', 200)] };
    });
    const summary = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] }));
    const { runtime, projectRoot } = harness(primary, summary, projectProviderExchanges, false);
    await runtime.submit({ userContent: `baseline round ${'x'.repeat(5000)}` });
    const result = await runtime.submit({ userContent: 'perform one tool' });

    expect(result.toolInvocations).toHaveLength(1);
    expect(calls).toHaveLength(4);
    expect(calls[2]!.inputId).toBe(calls[3]!.inputId);
    expect(projectProviderExchanges).toHaveBeenCalledTimes(1);
    const rows = readConversation(projectRoot, 'analyst:global').physicalRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'accepted-tool')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'accepted-tool')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'context_compaction')).toHaveLength(1);
    expect(countContent(rows, 'perform one tool')).toBe(1);
    expect(rows.filter((row) => row.kind === 'activity' && JSON.parse(row.content).event === 'activation_open')).toHaveLength(2);
  });

  it('publishes confirmed restart as an exact marker/user batch without model continuation', async () => {
    const primary = jest.fn(async (input: LlmInvocationInput) => ({ result: { kind: 'tool_calls' as const, tool_calls: [{ id: 'restart-call', type: 'function' as const, function: { name: 'restart_server', arguments: '{}' } }] }, provider_exchanges: [] }));
    const { runtime, projectRoot, scheduleRestart } = harness(primary, jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] })), jest.fn(), true, true);
    const requested = await runtime.submit({ userContent: 'restart when confirmed' });
    expect(requested.restart).toEqual({ status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' });
    const confirmed = await runtime.submit({ userContent: 'RESTART SERVER' });
    expect(confirmed.restart).toEqual({ status: 'scheduled' });
    expect(scheduleRestart).toHaveBeenCalledTimes(1);
    expect(primary).toHaveBeenCalledTimes(1);
    const classified = classifyConversationRounds('analyst:global', readConversation(projectRoot, 'analyst:global').sourceRows);
    expect(classified.rounds).toHaveLength(2);
    expect(classified.rounds[1]!.rows.map((row) => [row.message.role, row.message.kind, row.message.content])).toEqual([
      ['system', 'activity', expect.any(String)],
      ['user', 'text', 'RESTART SERVER'],
    ]);
  });

  it('fails dynamic preparation overflow before marker, provider, summary, or tool work', async () => {
    const primary = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
    const summary = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
    const promptTemplates = { render: jest.fn(() => 'x'.repeat(200_000)) } as never;
    const { runtime, projectRoot } = harness(primary, summary, jest.fn(), true, false, promptTemplates);
    await expect(runtime.submit({ userContent: 'must not be published' })).rejects.toThrow(/Prompt\/tool surface does not fit/);
    expect(primary).not.toHaveBeenCalled();
    expect(summary).not.toHaveBeenCalled();
    expect(readConversation(projectRoot, 'analyst:global').physicalRows).toEqual([]);
  });

  it('returns the existing cancelled outcome when preventive summary work is cancelled before a provider pass', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const compactor = jest.fn(async ({ signal }: { signal: AbortSignal }) => {
      entered();
      return new Promise<never>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const primary = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] }));
    const { runtime } = harness(primary, jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] })), jest.fn(), true, false, createTestPromptTemplateRegistry(), compactor as never);
    const pending = runtime.submit({ userContent: 'cancel while compacting' });
    await started;
    expect(runtime.cancel('operator cancelled')).toBe(true);
    await expect(pending).resolves.toMatchObject({ cancelled: true });
    expect(primary).not.toHaveBeenCalled();
    expect(compactor).toHaveBeenCalledTimes(1);
  });
});

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Analyst state.');
}

function harness(primary: (input: LlmInvocationInput, signal: AbortSignal) => Promise<any>, summary: (input: LlmInvocationInput, signal: AbortSignal) => Promise<any>, projectProviderExchanges = jest.fn(), preventive = true, restartServerAvailable = false, promptTemplates = createTestPromptTemplateRegistry(), compactImplementation = compact) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-analyst-compaction-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const runner = createTestProcessRunner(projectRoot);
  const eventBus = new EventBus();
  const config = saivageConfigSchema.parse({ models: { default: ['test/model'] }, providers: { test: { models: ['model'] } }, compaction: { enabled: true, input_budget_tokens: 20480, summarizer_candidate: { provider: 'test', account: null, model: 'model' } } });
  const { enabled: _enabled, summarizer_candidate: _candidate, ...compactionPolicy } = config.compaction;
  const summarizerProvider = { completeTurn: summary, projectProviderExchanges: jest.fn() };
  const scheduleRestart = jest.fn();
  const runtime = new AnalystRuntime({ projectRoot, config, runtimeDeps: {
    configAuthority: {}, cardStore: new CardService(projectRoot), runtime: { startProject: jest.fn(), pause: jest.fn(), resume: jest.fn(), stopProject: jest.fn(), cancelCard: jest.fn(), notifyCard: jest.fn(), getStatus: jest.fn() },
    emitAnalystToolInvoked: jest.fn(), eventBus, provider: { completeTurn: primary, projectProviderExchanges }, processRunner: runner, analystProcessRootScope: runner.analystRootScope,
    compactionPolicy, compactor: { shouldCompact: preventive ? (compactImplementation === compact ? shouldCompact : () => true) : () => false, compact: compactImplementation }, summarizerProvider,
    conversations: { projectRoot }, appLogs: testAppLogs(projectRoot), interventionReadiness: new RuntimeInterventionBinding(),
    runtimeProjectionChanged: jest.fn(), captureExecutingLlmSnapshots: () => [],
  } as never, promptTemplates, restartServerAvailable, restartPort: restartServerAvailable ? { schedule: scheduleRestart, acknowledge: jest.fn(async () => undefined) } : undefined });
  return { runtime, projectRoot, summarizerProvider, scheduleRestart };
}

function contextFailure(input: LlmInvocationInput): ProviderTurnFailure {
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: [exchange(input.inputId, 'error', 400)],
    originalFailure: new LlmRequestError({ kind: 'input_context_exhausted', provider: 'test', status: 400, message: 'context exhausted' }),
  });
}

function exchange(inputId: string, status: 'ok' | 'error', responseStatus: number): any {
  const base = { contract_id: 'analyst.test', contract_name: 'analyst', transport: 'generic', provider: 'test', model: 'model', source_input_id: inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-17T00:00:00.000Z', completed_at: '2026-07-17T00:00:00.001Z', response_status: responseStatus, terminal_tool_fired: null };
  return status === 'ok' ? { ...base, status } : { ...base, status, error: { name: 'LlmRequestError', message: 'failed', status: responseStatus } };
}

function countContent(rows: readonly { content: string }[], content: string): number {
  return rows.filter((row) => row.content === content).length;
}

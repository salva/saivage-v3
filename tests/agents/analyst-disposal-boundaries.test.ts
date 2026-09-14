import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystRuntime, AnalystSession } from '../../src/agents/analyst-handler.js';
import { ConversationLLMActor } from '../../src/runtime/actors/llm-actor.js';
import { ProviderTurnFailure, type ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { InvocationJoinOutcome } from '../../src/runtime/actors/invocation-lifecycle.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { RestartPort } from '../../src/contracts/index.js';
import { readConversation, type ConversationFileContext } from '../../src/persistence/conversation-file.js';
import { readAppLogEntries } from '../../src/persistence/app-log.js';
import { defineTool, executedNoneSettlement, executedToolOutcome, OPERATIONAL_RESULT_POLICY_TEMPLATE, type InvocationSurface } from '../../src/tools/invocation.js';
import { toolSucceeded, type ToolActionOutcome } from '../../src/contracts/tool-result.js';
import { settleToolActionOutcome } from '../../src/tools/tool-result-settlement.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { currentConversationSegmentPath } from '../helpers/current-conversation-segment-path.js';
import { LlmRequestError } from '../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../src/contracts/provider-exchange.js';
import { cardInspectionToolBinders } from '../../src/tools/card-inspection-provider.js';
import { bindToolProvider } from '../helpers/bind-tool-provider.js';
import { buildInvocationSurfaceFixture } from '../helpers/invocation-surface-fixture.js';
import { InvocationService } from '../../src/agents/invocation-service.js';

const sessionId = 'agent:analyst:global' as const;
const emptyStopReport = { selected: [], stopped: [], failed: [] };
const roots: string[] = [];

afterEach(() => {
  jest.restoreAllMocks();
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Analyst application-disposal ownership boundaries', () => {
  it('settles a real initial provider tool call when disposal wins at publication', async () => {
    const reason = new Error('application disposed after initial tool publication');
    let executions = 0;
    let fixture!: ReturnType<typeof createFixture>;
    fixture = createFixture({
      toolName: 'demo',
      beforeToolReturns: () => { executions += 1; },
      completeTurn: async () => {
        fixture.observer.arm(() => fixture.startDisposal(reason));
        return toolCall('initial-cancelled', 'demo');
      },
    });

    await expect(fixture.runtime.submit({ userContent: 'observe once' })).rejects.toBe(reason);

    const rows = readConversation(fixture.projectRoot, sessionId).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_call' && row.tool_call_id === 'initial-cancelled')).toHaveLength(1);
    const results = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'initial-cancelled');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'rejected_before_execution', evidence: { kind: 'none' } } });
    expect(executions).toBe(0);
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await fixture.expectDisposedAndCleaned();
  });

  it('settles a real continuation tool call once when disposal wins at publication', async () => {
    const reason = new Error('application disposed after continuation tool publication');
    let executions = 0;
    let fixture!: ReturnType<typeof createFixture>;
    fixture = createFixture({
      toolName: 'demo',
      beforeToolReturns: () => { executions += 1; },
      completeTurn: async () => {
        const turn = fixture.completeTurn.mock.calls.length;
        if (turn === 1) return toolCall('first-call', 'demo');
        if (turn === 2) {
          fixture.observer.arm(() => fixture.startDisposal(reason));
          return toolCall('continuation-cancelled', 'demo');
        }
        throw new Error('Cancelled Analyst turn continued to the provider.');
      },
    });

    await expect(fixture.runtime.submit({ userContent: 'observe twice' })).rejects.toBe(reason);

    const rows = readConversation(fixture.projectRoot, sessionId).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'first-call')).toHaveLength(1);
    const cancelled = rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'continuation-cancelled');
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'rejected_before_execution', evidence: { kind: 'none' } } });
    expect(executions).toBe(1);
    expect(fixture.completeTurn).toHaveBeenCalledTimes(2);
    await fixture.expectDisposedAndCleaned();
  });

  it('consumes a real terminal failure returned after publication suppresses its handoff', async () => {
    const reason = Object.freeze({ kind: 'non-error-disposal' });
    let fixture!: ReturnType<typeof createFixture>;
    const abandon = jest.spyOn(ConversationLLMActor.prototype, 'abandonParkedTurn');
    const prototype = AnalystSession.prototype as unknown as { terminalHandoff(operation: unknown): (completion: unknown) => void };
    const originalTerminalHandoff = prototype.terminalHandoff;
    let handoffs = 0;
    jest.spyOn(prototype, 'terminalHandoff').mockImplementation(function (this: AnalystSession, operation: unknown) {
      const callback = originalTerminalHandoff.call(this, operation);
      return (completion: unknown) => { handoffs += 1; callback(completion); };
    });
    fixture = createFixture({
      toolName: 'demo',
      completeTurn: async (input) => {
        const turn = fixture.completeTurn.mock.calls.length;
        if (turn === 1) return toolCall('first-call', 'demo');
        if (turn !== 2) throw new Error('Cancelled Analyst turn continued to the provider.');
        fixture.observer.arm(() => fixture.startDisposal(reason));
        throw providerFailure(input.inputId);
      },
    });

    await expect(fixture.runtime.submit({ userContent: 'observe then fail' })).rejects.toBe(reason);

    fixture.observer.expectOnePublication();
    const rows = readConversation(fixture.projectRoot, sessionId).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result' && row.tool_call_id === 'first-call')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'model_issue')).toHaveLength(1);
    expect(readAppLogEntries(fixture.projectRoot, 'provider_exchange')).toHaveLength(1);
    expect(rows.some((row) => row.role === 'system' && row.kind === 'text' && row.content.includes('Analyst LLM unavailable'))).toBe(false);
    expect(handoffs).toBe(0);
    expect(abandon).not.toHaveBeenCalled();
    expect(fixture.completeTurn).toHaveBeenCalledTimes(2);
    await fixture.expectDisposedAndCleaned();
  });

  it('records a real post-entry get_card validation failure and continues to a valid observation', async () => {
    let fixture!: ReturnType<typeof createFixture>;
    let calls = 0;
    const root = mkdtempSync(join(tmpdir(), 'analyst-get-card-entry-origin-'));
    roots.push(root);
    initProjectTree(root);
    const cards = new CardService(root);
    const surface = buildInvocationSurfaceFixture('analyst', [bindToolProvider('card-inspection', cardInspectionToolBinders, { store: cards, cardTypeVocabulary: cards.workflows.cardTypeVocabulary })]);
    fixture = createFixture({
      projectRoot: root,
      surface,
      completeTurn: async () => {
        calls += 1;
        if (calls === 1) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'invalid-summary-position', type: 'function', function: { name: 'get_card', arguments: JSON.stringify({ id: 'project', section: 'summary', position: { item_index: 0, item_byte_offset: 0 } }) } }] }, provider_exchanges: [] };
        if (calls === 2) return { result: { kind: 'tool_calls', tool_calls: [{ id: 'valid-summary', type: 'function', function: { name: 'get_card', arguments: JSON.stringify({ id: 'project', section: 'summary' }) } }] }, provider_exchanges: [] };
        return { result: { kind: 'message', content: 'Observation complete.' }, provider_exchanges: [] };
      },
    });

    await expect(fixture.runtime.submit({ userContent: 'inspect the project card' })).resolves.toMatchObject({ sessionId });

    const rows = readConversation(root, sessionId).sourceRows;
    const invalid = rows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'invalid-summary-position');
    const valid = rows.find((row) => row.kind === 'tool_result' && row.tool_call_id === 'valid-summary');
    expect(invalid).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'executed', evidence: { kind: 'none' } } });
    expect(invalid?.content).toContain("Section 'summary' is a bounded scalar section and accepts no position.");
    expect(valid).toMatchObject({ context_policy: { kind: 'tool_result', settlement_origin: 'executed', evidence: { kind: 'observational_query' } } });
    expect(valid?.content).toContain('"success":true');
    expect(calls).toBe(3);
  });

  it('retains the entered startup ingress batch and admits no provider work', async () => {
    const fixture = createFixture();
    const reason = new Error('application disposed during startup ingress publication');
    fixture.observer.arm(() => fixture.startDisposal(reason));

    await expect(fixture.runtime.submit({ userContent: 'inspect the project' })).rejects.toBe(reason);

    fixture.observer.expectOnePublication();
    expect(envelopes(fixture.projectRoot).map((envelope) => envelope.rows.length)).toEqual([3]);
    expect(sequence(fixture.projectRoot)).toEqual([
      ['system', 'activity', 'activation_open'],
      ['system', 'text', '[workspace-context] none — no entity is currently in focus'],
      ['user', 'text', 'inspect the project'],
    ]);
    expect(fixture.completeTurn).not.toHaveBeenCalled();
    await fixture.expectDisposedAndCleaned();
  });

  it('retains the caller-supplied ordinary tool result and admits no continuation', async () => {
    const reason = new Error('application disposed during ordinary tool-result publication');
    const suppliedResult = toolSucceeded({ value: 'caller supplied' });
    let fixture!: ReturnType<typeof createFixture>;
    fixture = createFixture({
      toolName: 'demo',
      toolResult: suppliedResult,
      beforeToolReturns: () => fixture.observer.arm(() => fixture.startDisposal(reason)),
    });

    await expect(fixture.runtime.submit({ userContent: 'run the demo tool' })).rejects.toBe(reason);

    fixture.observer.expectOnePublication();
    expect(envelopes(fixture.projectRoot).map((envelope) => envelope.rows.length)).toEqual([3, 1, 1, 1]);
    expectToolSequence(fixture.projectRoot, 'demo', suppliedResult, 'run the demo tool');
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await fixture.expectDisposedAndCleaned();
  });

  it('retains a successful restart result without installing confirmation or continuing', async () => {
    const reason = new Error('application disposed during restart result publication');
    const suppliedResult = toolSucceeded({ restart: 'confirmation_required' });
    let fixture!: ReturnType<typeof createFixture>;
    fixture = createFixture({
      toolName: 'restart_server',
      toolResult: suppliedResult,
      beforeToolReturns: () => fixture.observer.arm(() => fixture.startDisposal(reason)),
    });

    await expect(fixture.runtime.submit({ userContent: 'restart when confirmed' })).rejects.toBe(reason);

    fixture.observer.expectOnePublication();
    expect(envelopes(fixture.projectRoot).map((envelope) => envelope.rows.length)).toEqual([3, 1, 1, 1]);
    expectToolSequence(fixture.projectRoot, 'restart_server', suppliedResult, 'restart when confirmed');
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    expect(fixture.restartPort.schedule).not.toHaveBeenCalled();
    await fixture.expectDisposedAndCleaned();
  });

  it('suppresses restart scheduling when disposal enters from the confirmed-restart writer', async () => {
    const fixture = createFixture({ toolName: 'restart_server' });
    await expect(fixture.runtime.submit({ userContent: 'request restart' })).resolves.toMatchObject({
      restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
    });
    const reason = new Error('application disposed during confirmed restart publication');
    fixture.observer.arm(() => fixture.startDisposal(reason));

    await expect(fixture.runtime.submit({ userContent: 'RESTART SERVER' })).rejects.toBe(reason);

    fixture.observer.expectOnePublication();
    expect(envelopes(fixture.projectRoot).map((envelope) => envelope.rows.length)).toEqual([3, 1, 1, 1, 2]);
    expect(sequence(fixture.projectRoot).slice(-2)).toEqual([
      ['system', 'activity', 'activation_open'],
      ['user', 'text', 'RESTART SERVER'],
    ]);
    expect(fixture.restartPort.schedule).not.toHaveBeenCalled();
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await fixture.expectDisposedAndCleaned(3);
  });

  it('preserves an entered restart schedule and consumes confirmation', async () => {
    let fixture!: ReturnType<typeof createFixture>;
    const reason = new Error('application disposed after restart schedule entry');
    fixture = createFixture({
      toolName: 'restart_server',
      schedule: () => fixture.startDisposal(reason),
    });
    await expect(fixture.runtime.submit({ userContent: 'request restart' })).resolves.toMatchObject({
      restart: { status: 'confirmation_required', confirmationMessage: 'RESTART SERVER' },
    });
    fixture.observer.arm(() => undefined);

    await expect(fixture.runtime.submit({ userContent: 'RESTART SERVER' })).resolves.toMatchObject({
      restart: { status: 'scheduled' },
    });

    fixture.observer.expectOnePublication();
    expect(envelopes(fixture.projectRoot).map((envelope) => envelope.rows.length)).toEqual([3, 1, 1, 1, 2]);
    expect(sequence(fixture.projectRoot).slice(-2)).toEqual([
      ['system', 'activity', 'activation_open'],
      ['user', 'text', 'RESTART SERVER'],
    ]);
    expect(fixture.restartPort.schedule).toHaveBeenCalledTimes(1);
    expect(fixture.completeTurn).toHaveBeenCalledTimes(1);
    await fixture.expectDisposedAndCleaned(3);
  });
});

function createFixture(options: {
  toolName?: string;
  toolResult?: ToolActionOutcome;
  beforeToolReturns?: () => void;
  schedule?: () => void;
  completeTurn?: (input: LlmInvocationInput) => Promise<ProviderTurnCompletion>;
  projectRoot?: string;
  surface?: InvocationSurface;
} = {}) {
  const projectRoot = options.projectRoot ?? mkdtempSync(join(tmpdir(), 'analyst-disposal-boundary-'));
  if (!options.projectRoot) {
    roots.push(projectRoot);
    initProjectTree(projectRoot);
  }
  const observer = publicationObserver();
  const conversations: ConversationFileContext = {
    projectRoot,
    changes: { conversationChanged: observer.conversationChanged, agentMembershipChanged: jest.fn() },
  };
  const suppliedResult = options.toolResult ?? toolSucceeded({ restart: 'confirmation_required' });
  const definition = options.toolName
    ? defineTool({
        name: options.toolName,
        description: 'Test Analyst tool.',
        resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
        inputSchema: z.object({}).strict(),
        executor: async () => {
          options.beforeToolReturns?.();
          return executedToolOutcome('none', suppliedResult);
        },
      })
    : null;
  const surface: InvocationSurface = options.surface ?? (definition
    ? { agentName: 'analyst', tools: new Map([[definition.name, definition]]), providers: [{ providerName: 'test', tools: [definition] }] }
    : { agentName: 'analyst', tools: new Map(), providers: [] });
  const completeTurn = jest.fn(options.completeTurn ?? (async (): Promise<ProviderTurnCompletion> => {
    if (!options.toolName) return { result: { kind: 'message', content: 'unexpected provider admission' }, provider_exchanges: [] };
    return {
      result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: options.toolName, arguments: '{}' } }] },
      provider_exchanges: [],
    };
  }));
  const providerExchangeOwner = new InvocationService({
    projectRoot,
    freshness: { llmExchangeChanged() {} },
    registry: {} as never,
    candidateAvailability: {} as never,
  });
  const restartPort: RestartPort = {
    schedule: jest.fn(() => options.schedule?.()),
    acknowledge: jest.fn(async () => {}),
  };
  const shutdownProcesses = jest.fn(async () => {});
  const terminateRoot = jest.fn(async () => emptyStopReport);
  const session = new AnalystSession({
    cardTypeVocabulary: ['project','goal','architecture','code','test','doc','data','research','ops'],
    fatalPort: testApplicationFatalPort,
    sessionId,
    agentName: 'analyst', modelParams: { temperature: 0, maxTokens: 1000 }, capabilityRequest: { requiresTools: true, requiresExclusiveToolChoice: true },
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    routeUsableInputTokens: 80_000,
    promptTemplates: { render: () => 'test analyst prompt' },
    restartCapability: { available: true, port: restartPort },
    provider: {
      ...scriptedAdmissionProvider(completeTurn),
      projectProviderExchanges: (projectedSessionId, sourceInputId, attempts, context) =>
        providerExchangeOwner.projectProviderExchanges(projectedSessionId, sourceInputId, attempts, context),
    },
    conversations,
    compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: () => Promise.reject(new Error('Unexpected compaction.')) },
    summarizerProvider: unusedSummarizerProvider,
    cardStore: new CardService(projectRoot),
    runtimeCurrent: () => ({ status: 'stopped' as const, currentCardId: null }),
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses,
  });
  const runtime = new AnalystRuntime({ createSession: () => session, getAvailableToolNames: () => [], terminateRoot });
  let cleanup: Promise<void> | null = null;
  let joins: Promise<readonly InvocationJoinOutcome[]> | null = null;
  let disposalReason: unknown;
  let disposalStarted = false;

  return {
    projectRoot,
    observer,
    completeTurn,
    restartPort,
    runtime,
    startDisposal(reason: unknown) {
      if (cleanup || joins) throw new Error('Fixture disposal already started.');
      disposalStarted = true;
      disposalReason = reason;
      session.disposeSession(reason);
      cleanup = runtime.cleanupForApplicationStop();
      joins = session.joinSession();
    },
    async expectDisposedAndCleaned(expectedJoinCount = 2) {
      const durableConversation = readFileSync(currentConversationSegmentPath(projectRoot, sessionId), 'utf8');
      await expect(runtime.submit({ userContent: 'later' })).rejects.toThrow('Analyst admission is closed.');
      if (!cleanup || !joins || !disposalStarted) throw new Error('Fixture disposal did not start.');
      await expect(session.submit({ userContent: 'later through session' })).rejects.toBe(disposalReason);
      await expect(joins).resolves.toEqual(Array.from({ length: expectedJoinCount }, () => ({ status: 'joined' })));
      await expect(cleanup).resolves.toBeUndefined();
      expect(shutdownProcesses).toHaveBeenCalledTimes(1);
      expect(terminateRoot).toHaveBeenCalledTimes(1);
      expect(readFileSync(currentConversationSegmentPath(projectRoot, sessionId), 'utf8')).toBe(durableConversation);
    },
  };
}

function toolCall(id: string, name: string): ProviderTurnCompletion {
  return { result: { kind: 'tool_calls', tool_calls: [{ id, type: 'function', function: { name, arguments: '{}' } }] }, provider_exchanges: [] };
}

function providerFailure(inputId: string): ProviderTurnFailure {
  const attempt: ProviderExchangeAttempt = {
    contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test-model', source_input_id: inputId, attempt_index: 0,
    request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 1, temperature: 0, max_tokens: 1000 },
    started_at: '2026-09-14T00:00:00.000Z', completed_at: '2026-09-14T00:00:01.000Z', status: 'error', terminal_tool_fired: null,
    error: { name: 'LlmRequestError', message: 'terminal provider failure' },
  };
  return new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt], candidate: { provider: 'test', account: null, model: 'test-model' }, originalFailure: new LlmRequestError({ kind: 'server_transient', provider: 'test', status: 503, message: 'terminal provider failure' }) });
}

function publicationObserver() {
  let armed: (() => void) | null = null;
  let fired = 0;
  return {
    conversationChanged: jest.fn(() => {
      if (!armed) return;
      const effect = armed;
      armed = null;
      fired += 1;
      effect();
    }),
    arm(effect: () => void) {
      if (armed) throw new Error('Publication observer is already armed.');
      armed = effect;
    },
    expectOnePublication() {
      expect(fired).toBe(1);
      expect(armed).toBeNull();
    },
  };
}

function envelopes(projectRoot: string): Array<{ rows: Array<Record<string, unknown>> }> {
  const parsed = readFileSync(currentConversationSegmentPath(projectRoot, sessionId), 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as { rows: Array<Record<string, unknown>> });
  parsed[0]!.rows.shift();
  return parsed.filter((envelope) => envelope.rows.length > 0);
}

function sequence(projectRoot: string): Array<[unknown, unknown, unknown]> {
  return readConversation(projectRoot, sessionId).sourceRows.map((row) => [
    row.role,
    row.kind,
    row.kind === 'activity' ? (JSON.parse(row.content) as { event: string }).event : row.content,
  ]);
}

function expectToolSequence(projectRoot: string, toolName: string, result: ToolActionOutcome, userContent: string): void {
  const settlement = executedNoneSettlement(result);
  const rows = readConversation(projectRoot, sessionId).sourceRows;
  expect(rows.map((row) => [row.role, row.kind, row.kind === 'activity' ? (JSON.parse(row.content) as { event: string }).event : undefined])).toEqual([
    ['system', 'activity', 'activation_open'],
    ['system', 'text', undefined],
    ['user', 'text', undefined],
    ['system', 'activity', 'llm_turn_started'],
    ['assistant', 'tool_call', undefined],
    ['tool', 'tool_result', undefined],
  ]);
  expect(rows[2]!.content).toBe(userContent);
  const toolCall = rows[4]!;
  const toolResult = rows[5]!;
  expect(toolCall).toMatchObject({ tool: toolName, tool_call_id: 'call-1' });
  const sourceInputId = toolCall.id.slice(0, -':tool-call:call-1'.length);
  expect(toolResult).toMatchObject({
    id: `${sourceInputId}:tool-result:call-1`,
    role: 'tool',
    kind: 'tool_result',
    tool: toolName,
    tool_call_id: 'call-1',
    content: settleToolActionOutcome(settlement.execution.providerOutcome).settledResultBytes,
  });
  expect(rows.some((row) => row.content.includes('Cancelled:'))).toBe(false);
}

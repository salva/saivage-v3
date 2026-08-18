import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystRuntime, AnalystSession } from '../../src/agents/analyst-handler.js';
import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import type { InvocationJoinOutcome } from '../../src/runtime/actors/invocation-lifecycle.js';
import type { RestartPort } from '../../src/boot/restart-port.js';
import { readConversation, type ConversationFileContext } from '../../src/persistence/conversation-file.js';
import { defineTool, executedNoneSettlement, executedProviderResult, OPERATIONAL_RESULT_POLICY_TEMPLATE, settlementProviderResult, type InvocationSurface, type ToolResult } from '../../src/tools/invocation.js';
import { canonicalJson } from '../../src/schemas/index.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../helpers/test-application-fatal-port.js';
import { scriptedAdmissionProvider, testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';
import { currentConversationSegmentPath } from '../helpers/current-conversation-segment-path.js';

const sessionId = 'agent:analyst:global' as const;
const emptyStopReport = { selected: [], stopped: [], failed: [] };
const roots: string[] = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('Analyst application-disposal ownership boundaries', () => {
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
    const suppliedResult: ToolResult = { success: true, data: { value: 'caller supplied' } };
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
    const suppliedResult: ToolResult = { success: true, data: { restart: 'confirmation_required' } };
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
  toolResult?: ToolResult;
  beforeToolReturns?: () => void;
  schedule?: () => void;
} = {}) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-disposal-boundary-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const observer = publicationObserver();
  const conversations: ConversationFileContext = {
    projectRoot,
    changes: { conversationChanged: observer.conversationChanged, agentMembershipChanged: jest.fn() },
  };
  const suppliedResult = options.toolResult ?? { success: true, data: { restart: 'confirmation_required' } };
  const definition = options.toolName
    ? defineTool({
        name: options.toolName,
        description: 'Test Analyst tool.',
        resultPolicyTemplate: OPERATIONAL_RESULT_POLICY_TEMPLATE,
        inputSchema: z.object({}).strict(),
        executor: async () => {
          options.beforeToolReturns?.();
          return executedProviderResult('none', suppliedResult);
        },
      })
    : null;
  const surface: InvocationSurface = definition
    ? { agentName: 'analyst', tools: new Map([[definition.name, definition]]), providers: [{ providerName: 'test', tools: [definition] }] }
    : { agentName: 'analyst', tools: new Map(), providers: [] };
  const completeTurn = jest.fn(async (): Promise<ProviderTurnCompletion> => {
    if (!options.toolName) return { result: { kind: 'message', content: 'unexpected provider admission' }, provider_exchanges: [] };
    return {
      result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: options.toolName, arguments: '{}' } }] },
      provider_exchanges: [],
    };
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
    promptTemplates: { render: () => 'test analyst prompt' },
    restartServerAvailable: true,
    restartPort,
    provider: scriptedAdmissionProvider(completeTurn),
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
  let disposalReason: Error | null = null;

  return {
    projectRoot,
    observer,
    completeTurn,
    restartPort,
    runtime,
    startDisposal(reason: Error) {
      if (cleanup || joins) throw new Error('Fixture disposal already started.');
      disposalReason = reason;
      session.disposeSession(reason);
      cleanup = runtime.cleanupForApplicationStop();
      joins = session.joinSession();
    },
    async expectDisposedAndCleaned(expectedJoinCount = 2) {
      const durableConversation = readFileSync(currentConversationSegmentPath(projectRoot, sessionId), 'utf8');
      await expect(runtime.submit({ userContent: 'later' })).rejects.toThrow('Analyst admission is closed.');
      if (!cleanup || !joins || !disposalReason) throw new Error('Fixture disposal did not start.');
      await expect(session.submit({ userContent: 'later through session' })).rejects.toBe(disposalReason);
      await expect(joins).resolves.toEqual(Array.from({ length: expectedJoinCount }, () => ({ status: 'joined' })));
      await expect(cleanup).resolves.toBeUndefined();
      expect(shutdownProcesses).toHaveBeenCalledTimes(1);
      expect(terminateRoot).toHaveBeenCalledTimes(1);
      expect(readFileSync(currentConversationSegmentPath(projectRoot, sessionId), 'utf8')).toBe(durableConversation);
    },
  };
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

function expectToolSequence(projectRoot: string, toolName: string, result: ToolResult, userContent: string): void {
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
    content: canonicalJson(settlementProviderResult(settlement)),
  });
  expect(rows.some((row) => row.content.includes('Cancelled:'))).toBe(false);
}

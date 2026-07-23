import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { AnalystSession } from '../../src/agents/analyst-handler.js';
import type { ProviderTurnCompletion } from '../../src/agents/llm-contracts.js';
import { createEventLog } from '../../src/observability/index.js';
import type { LlmToolInvocationContext } from '../../src/runtime/actors/executing-llm-snapshot.js';
import { defineTool, type InvocationSurface } from '../../src/tools/invocation.js';
import { CardService, initProjectTree } from '../helpers/canonical-project.js';
import { testCompactionPolicy, unusedSummarizerProvider } from '../helpers/llm-test-helpers.js';
import { TEST_SAIVAGE_CONFIG } from '../helpers/test-saivage-config.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function toolCall(argumentsJson: string): ProviderTurnCompletion {
  return {
    result: { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'demo', arguments: argumentsJson } }] },
    provider_exchanges: [],
  };
}

function analyst(argumentsJson: string, executor: (args: { value: string }, signal: AbortSignal, context?: LlmToolInvocationContext) => Promise<{ success: true; data: unknown }>) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-tool-invocation-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  const definition = defineTool({
    name: 'demo',
    description: 'Demo tool.',
    inputSchema: z.object({ value: z.string() }).strict(),
    executor,
  });
  const surface: InvocationSurface = { agentName: 'analyst', tools: new Map([[definition.name, definition]]), providers: [{ providerName: 'demo', tools: [definition] }] };
  let turns = 0;
  const completeTurn = jest.fn(async (): Promise<ProviderTurnCompletion> => ++turns === 1
    ? toolCall(argumentsJson)
    : { result: { kind: 'message', content: 'done' }, provider_exchanges: [] });
  const session = new AnalystSession({
    projectRoot,
    sessionId: 'agent:analyst:global',
    config: TEST_SAIVAGE_CONFIG,
    candidateChain: [{ provider: 'test', account: null, model: 'test-model' }],
    promptTemplates: { render: () => 'test analyst prompt' },
    restartServerAvailable: false,
    provider: { completeTurn },
    conversations: { projectRoot },
    compactionPolicy: testCompactionPolicy,
    compactor: { shouldCompact: () => false, compact: () => Promise.reject(new Error('Unexpected compaction.')) },
    summarizerProvider: unusedSummarizerProvider,
    eventLogger: createEventLog(projectRoot),
    cardStore: new CardService(projectRoot),
    runtimeProjectionChanged() {},
    createInvocationSurface: () => surface,
    shutdownProcesses: async () => {},
  });
  return { session, completeTurn };
}

describe('Analyst parsed tool invocation', () => {
  it.each([
    { raw: '{', violation: 'tool_args_invalid_json' },
    { raw: '[]', violation: 'tool_args_not_object' },
  ])('keeps $violation in the Analyst protocol-violation branch', async ({ raw, violation }) => {
    const executor = jest.fn(async () => ({ success: true as const, data: 'unused' }));
    const test = analyst(raw, executor);

    const response = await test.session.submit({ userContent: 'test malformed arguments' });

    expect(executor).not.toHaveBeenCalled();
    expect(response.toolInvocations).toHaveLength(1);
    expect(response.toolInvocations![0]!.params).toEqual({});
    expect(JSON.parse(response.toolInvocations![0]!.result.error!)).toMatchObject({ kind: 'agent_protocol_violation', violation });
  });

  it('passes a valid parsed object and complete actor-built context directly to the LLM invocation boundary', async () => {
    let receivedContext: LlmToolInvocationContext | undefined;
    const executor = jest.fn(async (args: { value: string }, _signal: AbortSignal, context?: LlmToolInvocationContext) => {
      receivedContext = context;
      return { success: true as const, data: args };
    });
    const test = analyst('{"value":"ok"}', executor);

    const response = await test.session.submit({ userContent: 'test valid arguments' });
    const invocation = response.toolInvocations![0]!;

    expect(executor).toHaveBeenCalledTimes(1);
    expect(executor.mock.calls[0]![0]).toEqual({ value: 'ok' });
    expect(invocation.params).toEqual({ value: 'ok' });
    expect(invocation.result).toEqual({ success: true, data: { value: 'ok' } });
    expect(receivedContext).toMatchObject({
      sessionId: 'agent:analyst:global',
      sourceInputId: invocation.sourceInputId,
      toolCallId: 'call-1',
      toolName: 'demo',
      waits: { waitExternal: expect.any(Function), waitProcess: expect.any(Function) },
      childInvocation: { reserveChild: expect.any(Function) },
    });
    expect(receivedContext!.childInvocation.identity).toEqual({
      sessionId: 'agent:analyst:global',
      sourceInputId: invocation.sourceInputId,
      toolCallId: 'call-1',
      toolName: 'demo',
    });
  });

  it('keeps valid-object schema rejection at the invocation boundary', async () => {
    const executor = jest.fn(async () => ({ success: true as const, data: 'unused' }));
    const test = analyst('{"value":1}', executor);

    const response = await test.session.submit({ userContent: 'test schema rejection' });

    expect(executor).not.toHaveBeenCalled();
    expect(response.toolInvocations![0]!.params).toEqual({ value: 1 });
    expect(response.toolInvocations![0]!.result).toMatchObject({ success: false, error: expect.stringContaining('Expected string') });
  });
});

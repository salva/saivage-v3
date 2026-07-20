import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InvocationService } from '../../../src/agents/invocation-service.js';
import { ProviderTurnFailure, type LlmCompleteResult } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { readAppLogEntries } from '../../../src/persistence/app-log.js';
import { agentMessageSchema, type ConversationSessionId } from '../../../src/schemas/index.js';
import { summarizeMerge, summarizeRound, SummarizerExchangeProjectionError, type SummarizerProviderPort } from '../../../src/runtime/actors/compaction/summarizer.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { testAppLogs } from '../../helpers/app-logs.js';
import { ReadModelChangeBroadcaster } from '../../../src/application/read-model-changes.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('summarizer provider-exchange evidence ownership', () => {
  it.each(['round', 'merge'] as const)('projects one successful %s attempt under its distinct summary identity with empty output ids', async (kind) => {
    const { root, provider, project } = evidenceProvider((input) => ({ result: { kind: 'message', content: 'summary' }, provider_exchanges: [attempt(input, 'ok')] }));

    if (kind === 'round') await summarizeRound({ sourceSessionId: 'planner:project', round_id: 'round-1', rows: [sourceRow()], summarizerProvider: provider, signal: new AbortController().signal });
    else await summarizeMerge({ entries: [{ round_id: 'round-1', summary_text: 'prior' }], summarizerProvider: provider, signal: new AbortController().signal });

    expect(project).toHaveBeenCalledTimes(1);
    const [sessionId, inputId, attempts, outputIds] = project.mock.calls[0]!;
    expect(sessionId).toBe(kind === 'round' ? 'summary:round-1' : 'summary:merge');
    expect(inputId).toMatch(/^[0-9a-f-]{36}$/);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.source_input_id).toBe(inputId);
    expect(outputIds).toEqual([]);
    const entries = readAppLogEntries(root, 'provider_exchange');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.data).toMatchObject({ session_id: sessionId, source_input_id: inputId, attempt_index: 0, payload: { status: 'ok', assistant_output_ids: [] } });
    if (kind === 'round') expect(sessionId).not.toBe('planner:project');
  });

  it('projects ProviderTurnFailure attempts once before rethrowing the exact failure', async () => {
    let failure!: ProviderTurnFailure;
    const { root, provider, project } = evidenceProvider((input) => {
      failure = new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt(input, 'error')], originalFailure: new Error('provider failed') });
      throw failure;
    });

    await expect(summarizeRound(summaryRoundArgs(provider))).rejects.toBe(failure);
    expect(project).toHaveBeenCalledTimes(1);
    expect(readAppLogEntries(root, 'provider_exchange')).toHaveLength(1);
    expect(readAppLogEntries(root, 'provider_exchange')[0]!.data.payload.status).toBe('error');
  });

  it.each([
    ['empty', { kind: 'message', content: '' }],
    ['malformed prose', { kind: 'message', content: 'Recoverable evidence: hidden' }],
    ['tool call', { kind: 'tool_calls', tool_calls: [] }],
  ] as Array<[string, LlmCompleteResult]>)('projects success once before rejecting %s summary content', async (_label, result) => {
    const { root, provider, project } = evidenceProvider((input) => ({ result, provider_exchanges: [attempt(input, 'ok')] }));

    await expect(summarizeRound(summaryRoundArgs(provider))).rejects.toThrow();
    expect(project).toHaveBeenCalledTimes(1);
    expect(readAppLogEntries(root, 'provider_exchange')).toHaveLength(1);
  });

  it('projects a settled cancellation failure under summary identity but not a plain abort without attempts', async () => {
    const cancelled = new LlmRequestError({ kind: 'cancelled', provider: 'test', message: 'cancelled', reason: 'abort' });
    const settled = evidenceProvider((input) => {
      throw new ProviderTurnFailure({ failure_phase: 'provider_attempt', provider_exchanges: [attempt(input, 'error')], originalFailure: cancelled });
    });
    await expect(summarizeRound(summaryRoundArgs(settled.provider))).rejects.toMatchObject({ cause: cancelled });
    expect(settled.project).toHaveBeenCalledTimes(1);
    expect(readAppLogEntries(settled.root, 'provider_exchange')).toHaveLength(1);

    const controller = new AbortController();
    const plainReason = new Error('plain abort');
    const plain = evidenceProvider(() => { controller.abort(plainReason); throw plainReason; });
    await expect(summarizeRound({ ...summaryRoundArgs(plain.provider), signal: controller.signal })).rejects.toBe(plainReason);
    expect(plain.project).not.toHaveBeenCalled();
    expect(readAppLogEntries(plain.root, 'provider_exchange')).toEqual([]);
  });

  it('turns projection publication uncertainty into one typed fatal error without retry', async () => {
    const projectionCause = new Error('app log publication unknown');
    let completion: ReturnType<SummarizerProviderPort['completeTurn']> extends Promise<infer T> ? T : never;
    const completeTurn = jest.fn(async (input: LlmInvocationInput) => {
      completion = { result: { kind: 'message', content: 'summary' }, provider_exchanges: [attempt(input, 'ok')] };
      return completion;
    });
    const projectProviderExchanges = jest.fn<SummarizerProviderPort['projectProviderExchanges']>(() => { throw projectionCause; });

    await expect(summarizeRound(summaryRoundArgs({ completeTurn, projectProviderExchanges }))).rejects.toMatchObject({
      name: 'SummarizerExchangeProjectionError',
      projectionCause,
      providerOutcome: completion!,
      cause: projectionCause,
    } satisfies Partial<SummarizerExchangeProjectionError>);
    expect(completeTurn).toHaveBeenCalledTimes(1);
    expect(projectProviderExchanges).toHaveBeenCalledTimes(1);
    const [sessionId, sourceInputId, attempts, outputIds] = projectProviderExchanges.mock.calls[0]!;
    expect(sessionId).toBe('summary:round-1');
    expect(sessionId).not.toBe('planner:project');
    expect(sourceInputId).not.toBe('source');
    expect(attempts[0]!.source_input_id).toBe(sourceInputId);
    expect(outputIds).toEqual([]);
  });
});

function evidenceProvider(complete: (input: LlmInvocationInput) => ReturnType<SummarizerProviderPort['completeTurn']> extends Promise<infer T> ? T : never) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-summary-evidence-'));
  roots.push(root);
  const service = new InvocationService({ projectRoot: root, saivageDir: root, appLogs: testAppLogs(root), readModelChanges: new ReadModelChangeBroadcaster(), registry: {} as never, router: {} as never, candidateAvailability: {} as never });
  const project = jest.fn((sessionId: string, sourceInputId: string, attempts: ProviderExchangeAttempt[], assistantOutputIds: string[]) => service.projectProviderExchanges(sessionId, sourceInputId, attempts, assistantOutputIds));
  const provider: SummarizerProviderPort = { completeTurn: async (input) => complete(input), projectProviderExchanges: project };
  return { root, provider, project };
}

function summaryRoundArgs(summarizerProvider: SummarizerProviderPort): { sourceSessionId: ConversationSessionId; round_id: string; rows: ReturnType<typeof sourceRow>[]; summarizerProvider: SummarizerProviderPort; signal: AbortSignal } {
  return { sourceSessionId: 'planner:project', round_id: 'round-1', rows: [sourceRow()], summarizerProvider, signal: new AbortController().signal };
}

function sourceRow() {
  return agentMessageSchema.parse({ id: 'source', session_id: 'planner:project', role: 'user', kind: 'text', content: 'work', round_id: 'r-user-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp: '2026-07-17T00:00:00.000Z' });
}

function attempt(input: LlmInvocationInput, status: 'ok' | 'error'): ProviderExchangeAttempt {
  const base = { contract_id: 'summary.v1', contract_name: 'summary', transport: 'generic' as const, provider: 'test', model: 'summary', source_input_id: input.inputId, attempt_index: 0, request_params: {}, started_at: '2026-07-17T00:00:00.000Z', completed_at: '2026-07-17T00:00:00.001Z', terminal_tool_fired: null };
  return status === 'ok' ? { ...base, status: 'ok', response_status: 200 } : { ...base, status: 'error', response_status: 500, error: { name: 'Error', message: 'provider failed', status: 500 } };
}

import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProviderTurnFailure } from '../../../src/agents/llm-contracts.js';
import { LlmRequestError } from '../../../src/contracts/llm-failure.js';
import type { ProviderExchangeAttempt } from '../../../src/contracts/provider-exchange.js';
import { PublicationOutcomeUnknownError } from '../../../src/contracts/index.js';
import { readConversation } from '../../../src/persistence/conversation-file.js';
import { ConversationLLMActor, LastChanceSummaryProviderUnavailableError, type CompactorPort } from '../../../src/runtime/actors/llm-actor.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import type { PreparedLlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { preparedInvocationContextFixture } from '../../helpers/prepared-invocation-context.js';
import { actorProvider } from '../../helpers/actor-provider.js';
import { AdmittedProviderTurnFailure } from '../../../src/agents/invocation-service.js';

const CANDIDATE = { provider: 'test', account: null, model: 'test-model' } as const;
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('ConversationLLMActor last-chance summary publication ownership', () => {
  it('publishes summary and triggering attempts once under separate identities and rejects with the fieldless ownership marker', async () => {
    const fixture = actorFixture();
    const summaryFailure = providerFailure('summary-input', 'server_transient');
    fixture.compact.mockImplementation(async ({ summarizerProvider }) => {
      summarizerProvider.projectProviderExchanges('agent:compaction-summarizer:global', 'summary-input', summaryFailure.provider_exchanges, { assistantOutputIds: [], terminalConversationOutputId: null });
      throw summaryFailure;
    });

    let rejection: unknown;
    try { await fixture.actor.turn(fixture.input, undefined, jest.fn()); }
    catch (error) { rejection = error; }

    expect(rejection).toBeInstanceOf(LastChanceSummaryProviderUnavailableError);
    expect((rejection as Error).cause).toBe(summaryFailure);
    expect(rejection).not.toBeInstanceOf(ProviderTurnFailure);
    expect(Object.keys(rejection as object)).toEqual(['name']);
    expect(rejection).not.toHaveProperty('provider_exchanges');
    expect(rejection).not.toHaveProperty('failure_phase');
    expect(rejection).not.toHaveProperty('candidate');
    expect(fixture.summaryProjection).toHaveBeenCalledTimes(1);
    expect(fixture.summaryProjection).toHaveBeenCalledWith('agent:compaction-summarizer:global', 'summary-input', expect.any(Array), { assistantOutputIds: [], terminalConversationOutputId: null });
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(fixture.plannerProjection).toHaveBeenCalledWith(fixture.input.sessionId, fixture.input.inputId, expect.arrayContaining([expect.objectContaining({ source_input_id: fixture.input.inputId, attempt_index: 0 })]), { assistantOutputIds: [], terminalConversationOutputId: null });
    const conversation = readConversation(fixture.root, fixture.input.sessionId);
    expect(conversation.sourceRows.some((row) => row.kind === 'model_issue')).toBe(false);
    expect(conversation.compactions).toHaveLength(0);
  });

  it.each([
    new Error('planner exchange publication failed'),
    new PublicationOutcomeUnknownError(),
  ])('keeps triggering-attempt publication failure authoritative instead of creating the marker', async (publicationFailure) => {
    const fixture = actorFixture(publicationFailure);
    const summaryFailure = providerFailure('summary-input', 'server_transient');
    fixture.compact.mockRejectedValue(summaryFailure);

    await expect(fixture.actor.turn(fixture.input, undefined, jest.fn())).rejects.toBe(publicationFailure);
    expect(fixture.plannerProjection).toHaveBeenCalledTimes(1);
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows.some((row) => row.kind === 'model_issue')).toBe(false);
    if (publicationFailure instanceof PublicationOutcomeUnknownError)
      expect(fixture.publicationOutcomeUnknown).toHaveBeenCalledWith(publicationFailure);
  });
});

function actorFixture(plannerPublicationFailure?: Error) {
  const root = mkdtempSync(join(tmpdir(), 'saivage-last-chance-summary-'));
  roots.push(root);
  initProjectTree(root);
  const input = invocation();
  const firstFailure = providerFailure(input.inputId, 'input_context_exhausted');
  const plannerProjection = jest.fn(() => {
    if (plannerPublicationFailure) throw plannerPublicationFailure;
  });
  const summaryProjection = jest.fn();
  const compact = jest.fn<CompactorPort['compact']>();
  const publicationOutcomeUnknown = jest.fn((_error: PublicationOutcomeUnknownError) => undefined);
  const provider = actorProvider(jest.fn(async () => { throw firstFailure; }), plannerProjection);
  provider.executeAdmitted = async () => { throw new AdmittedProviderTurnFailure(firstFailure, {} as never); };
  const actor = new ConversationLLMActor({
    purpose: { kind: 'autonomous-card', cardId: 'project' },
    gate: new RuntimeGate(),
    agentId: input.sessionId,
    provider,
    conversations: { projectRoot: root },
    compactor: { shouldCompact: () => false, compact },
    summarizerProvider: { candidate: CANDIDATE, completeTurn: jest.fn(async () => { throw new Error('unexpected summary provider call'); }), projectProviderExchanges: summaryProjection },
    fatalPort: { publicationOutcomeUnknown: publicationOutcomeUnknown as unknown as (error: PublicationOutcomeUnknownError) => never },
  });
  return { root, input, actor, compact, plannerProjection, summaryProjection, publicationOutcomeUnknown };
}

function invocation(): PreparedLlmInvocationInput {
  const sessionId = 'agent:planner:project' as const;
  return {
    inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName: 'planner', sessionId,
    ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: sessionId, messages: [] }, modelParams: { temperature: 0 },
    preparedCompaction: prepareCompaction({ input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.6, snap: 'compact_straddler' }, 'system', []),
    capabilityRequest: {}, routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] }, episodeContext: {},
  };
}

function providerFailure(inputId: string, kind: 'input_context_exhausted' | 'server_transient'): ProviderTurnFailure {
  return new ProviderTurnFailure({
    failure_phase: 'provider_attempt',
    provider_exchanges: [attempt(inputId)],
    originalFailure: new LlmRequestError({ kind, provider: 'test', status: 200, message: kind }),
    candidate: CANDIDATE,
  });
}

function attempt(source_input_id: string): ProviderExchangeAttempt {
  return { contract_id: 'test.v1', contract_name: 'test', transport: 'generic', provider: 'test', model: 'test-model', source_input_id, attempt_index: 0, request_params: { endpoint: 'https://example.invalid', method: 'POST', stream: false, offered_tools_count: 0, temperature: 0, max_tokens: 10 }, started_at: '2026-08-10T00:00:00.000Z', completed_at: '2026-08-10T00:00:01.000Z', status: 'error', terminal_tool_fired: null, error: { name: 'LlmRequestError', message: 'provider failed' } };
}

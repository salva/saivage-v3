import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConversationLLMActor, type CompactorPort, type LLMProviderPort } from '../../../src/runtime/actors/llm-actor.js';
import { LocalExactAdmissionError, type AdmissionDiagnostic } from '../../../src/agents/invocation-service.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { agentMessageSchema } from '../../../src/schemas/index.js';
import { RuntimeGate } from '../../../src/runtime/runtime-gate.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';
import { preparedInvocationContextFixture } from '../../helpers/prepared-invocation-context.js';
import { initProjectTree } from '../../helpers/canonical-project.js';
import { testApplicationFatalPort } from '../../helpers/test-application-fatal-port.js';
import { unusedSummarizerProvider } from '../../helpers/llm-test-helpers.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });
const diagnostic: AdmissionDiagnostic = { verdictSha256: 'a'.repeat(64), totalCandidates: 1, omittedCandidateCount: 0, counts: { projection_too_large: 1 }, candidates: [] };

describe('ConversationLLMActor exact local admission transition', () => {
  it('compacts and re-admits once before turn-start or primary transport', async () => {
    const fixture = setup();
    let preparations = 0;
    const executeAdmitted = jest.fn(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
    const provider = port({
      preparePrimaryRequest(input) {
        preparations++;
        if (preparations === 1) return { kind: 'local_compaction_required', candidates: [], diagnostic } as never;
        return { kind: 'admitted', request: input } as never;
      },
      executeAdmitted,
    });
    const compact = jest.fn<CompactorPort['compact']>(async (request) => {
      expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows).toEqual([fixture.activation]);
      expect(executeAdmitted).not.toHaveBeenCalled();
      expect(request.input.providerConversation).toEqual(fixture.input.providerConversation);
      expect(request.input.prefix).toBe(fixture.input.prefix);
      expect(request.input.dynamicBlocks).toBe(fixture.input.dynamicBlocks);
      expect(request.input.capabilityRequest).toBe(fixture.input.capabilityRequest);
      return { kind: 'compacted' as const, providerConversation: fixture.input.providerConversation, compactionMessage: fixture.activation, estimatedProviderMessageTokens: 1 };
    });
    const actor = new ConversationLLMActor({ purpose: { kind: 'autonomous-card', cardId: 'project' }, gate: new RuntimeGate(), agentId: fixture.input.sessionId, provider, conversations: { projectRoot: fixture.root }, compactor: { shouldCompact: () => false, compact }, summarizerProvider: unusedSummarizerProvider, fatalPort: testApplicationFatalPort });
    await expect(actor.turn(fixture.input, undefined, jest.fn())).resolves.toMatchObject({ type: 'result', result: { content: 'done' } });
    expect(preparations).toBe(2);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact.mock.calls[0]![0].strategy).toBe('local_exact_admission');
    expect(executeAdmitted).toHaveBeenCalledTimes(1);
  });

  it('fails a second no-fit without turn-start, transport, or another compaction', async () => {
    const fixture = setup();
    const executeAdmitted = jest.fn<LLMProviderPort['executeAdmitted']>();
    const provider = port({ preparePrimaryRequest: () => ({ kind: 'local_compaction_required', candidates: [], diagnostic }) as never, executeAdmitted });
    const compact = jest.fn<CompactorPort['compact']>(async () => ({ kind: 'compacted' as const, providerConversation: fixture.input.providerConversation, compactionMessage: fixture.activation, estimatedProviderMessageTokens: 1 }));
    const actor = new ConversationLLMActor({ purpose: { kind: 'autonomous-card', cardId: 'project' }, gate: new RuntimeGate(), agentId: fixture.input.sessionId, provider, conversations: { projectRoot: fixture.root }, compactor: { shouldCompact: () => false, compact }, summarizerProvider: unusedSummarizerProvider, fatalPort: testApplicationFatalPort });
    await expect(actor.turn(fixture.input, undefined, jest.fn())).rejects.toBeInstanceOf(LocalExactAdmissionError);
    expect(compact).toHaveBeenCalledTimes(1);
    expect(executeAdmitted).not.toHaveBeenCalled();
    expect(readConversation(fixture.root, fixture.input.sessionId).sourceRows).toEqual([fixture.activation]);
  });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'actor-local-admission-')); roots.push(root); initProjectTree(root);
  const sessionId = 'agent:planner:project' as const;
  const timestamp = '2026-08-17T00:00:00.000Z';
  const activation = agentMessageSchema.parse({ id: 'activation', session_id: sessionId, role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: 'r-pre-00000000000000000000000000000000', message_index: 0, block_index: 0, timestamp });
  appendConversationBatch({ projectRoot: root }, [activation]);
  const input = { inputId: '00000000-0000-4000-8000-000000000001', agentId: sessionId, agentName: 'planner' as const, sessionId, ...preparedInvocationContextFixture(), providerConversation: { sourceSessionId: sessionId, messages: [] }, modelParams: { temperature: 0 }, preparedCompaction: prepareCompaction({ input_budget_tokens: 1000, trigger_fraction: .8, completion_reserve_fraction: .2, merge_line_fraction: .3, summary_line_fraction: .5, escalate_merge_line_fraction: .4, escalate_summary_line_fraction: .6, snap: 'compact_straddler' }, 'system', [], 100), capabilityRequest: {}, routePass: { kind: 'ordinary' as const, candidateChain: [{ provider: 'test', account: null, model: 'test-model' }] }, episodeContext: {} };
  return { root, input, activation };
}

function port(overrides: Partial<LLMProviderPort>): LLMProviderPort {
  return {
    preparePrimaryRequest: () => { throw new Error('prepare not supplied'); },
    executeAdmitted: async () => { throw new Error('execute not supplied'); },
    resumeSuspended: async () => { throw new Error('unexpected resume'); },
    preflightPinned: () => { throw new Error('unexpected pin'); },
    executePinned: async () => { throw new Error('unexpected pin'); },
    ...overrides,
  };
}

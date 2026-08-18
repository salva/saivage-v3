import { describe, expect, it } from '@jest/globals';

import { executeAdmittedTurn } from '../../src/application/invocation-service-provider.js';
import { AdmissionIntegrityError, LocalExactAdmissionError, ordinaryAdmittedExecutionAuthority } from '../../src/agents/invocation-admission.js';
import type { InvocationRequest, InvocationService } from '../../src/agents/invocation-service.js';
import type { OrdinaryAdmittedExecution } from '../../src/agents/invocation-admission.js';
import type { LlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import { selectLlmProtocolAdapter } from '../../src/agents/llm-protocol-adapter.js';
import { buildCandidateRequest } from '../../src/agents/candidate-request.js';
import { createHash } from 'node:crypto';

const CANDIDATE = { provider: 'test', account: null, model: 'summary' } as const;

function summaryInput(): LlmInvocationInput {
  return {
    inputId: '00000000-0000-4000-8000-000000000009',
    agentId: 'llm:internal-compaction-summary',
    agentName: 'internal-compaction-summary',
    sessionId: 'internal:compaction-summary:0123',
    systemPrompt: 'instruction',
    providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] },
    tools: [],
    compiledToolContracts: [],
    terminalToolNames: [],
    modelParams: { temperature: 0, maxTokens: 2000 },
    capabilityRequest: { requiresTools: false, requiresExclusiveToolChoice: true },
    routePass: { kind: 'ordinary', candidateChain: [CANDIDATE] },
    episodeContext: { compaction: true },
  };
}

function admittedExecution(plan: ReturnType<typeof buildCandidateRequest>): OrdinaryAdmittedExecution {
  return Object.freeze({
    kind: 'admitted',
    routePass: { kind: 'ordinary' as const, candidateChain: [CANDIDATE] },
    candidates: Object.freeze([Object.freeze({ kind: 'admitted' as const, plan, candidate: CANDIDATE, capabilityRequest: Object.freeze({ requiresTools: false, requiresExclusiveToolChoice: true }), capabilityRequestSha256: '0'.repeat(64) })]),
    executionAuthority: ordinaryAdmittedExecutionAuthority([CANDIDATE]),
    bindings: Object.freeze({ inputId: 'x', sessionId: 'internal:compaction-summary:0123', agentName: 'internal-compaction-summary' as never, sourceSessionId: 'agent:planner:project', systemPromptSha256: '0'.repeat(64), toolsSha256: '0'.repeat(64), terminalToolNamesSha256: '0'.repeat(64), capabilityRequest: Object.freeze({}), capabilityRequestSha256: '0'.repeat(64), temperature: 0, requestedCompletionTokens: 2000, inputBudgetTokens: null, preparedCompactionSha256: '0'.repeat(64) }),
    execution: Object.freeze({ sessionId: 'internal:compaction-summary:0123', capabilityRequest: Object.freeze({ requiresTools: false, requiresExclusiveToolChoice: true }), options: Object.freeze({ inputId: 'x', temperature: 0, max_tokens: 2000, tools: [], tool_choice: 'auto', contract_id: 'internal-compaction-summary.v1', contractName: 'internal-compaction-summary', terminalToolOffered: [] }) }),
  });
}

describe('executeAdmittedTurn summary byte reuse', () => {
  it('sends the retained admitted request bytes and fails the integrity check when send-side bytes diverge', async () => {
    const input = summaryInput();
    const capabilities = { transportProtocol: 'openai-chat-completions' as const, toolsMode: 'native' as const, exclusiveToolChoiceSupport: 'native' as const, quirks: [] };
    const plan = buildCandidateRequest({
      candidate: CANDIDATE,
      capabilities,
      adapter: selectLlmProtocolAdapter(capabilities.transportProtocol),
      systemPrompt: input.systemPrompt,
      providerConversation: input.providerConversation,
      options: { inputId: input.inputId, temperature: 0, max_tokens: 2000, tools: [], tool_choice: 'auto', contract_id: 'internal-compaction-summary.v1', contractName: 'internal-compaction-summary', terminalToolOffered: [] },
    });
    const sent: string[] = [];
    const service = {
      preparePrimaryRequestAdmission: (request: InvocationRequest) => admittedExecution(buildCandidateRequest({
        candidate: CANDIDATE,
        capabilities,
        adapter: selectLlmProtocolAdapter(capabilities.transportProtocol),
        systemPrompt: request.systemPrompt,
        providerConversation: request.providerConversation,
        options: { inputId: request.inputId, temperature: 0, max_tokens: 2000, tools: [], tool_choice: 'auto', contract_id: 'internal-compaction-summary.v1', contractName: 'internal-compaction-summary', terminalToolOffered: [] },
      })),
      executeAdmittedWithRecovery: async (admission: OrdinaryAdmittedExecution) => {
        sent.push([...admission.candidates].find((verdict) => verdict.kind === 'admitted')!.plan.request.serializedBody);
        return { result: { kind: 'message' as const, content: 'summary' }, provider_exchanges: [] };
      },
    } as unknown as InvocationService;

    await expect(executeAdmittedTurn(service, input, new AbortController().signal, plan.request.requestHash)).resolves.toMatchObject({ result: { kind: 'message', content: 'summary' } });
    expect(sent).toHaveLength(1);
    expect(createHash('sha256').update(sent[0]!, 'utf8').digest('hex')).toBe(plan.request.requestHash);

    await expect(executeAdmittedTurn(service, input, new AbortController().signal, 'f'.repeat(64))).rejects.toBeInstanceOf(AdmissionIntegrityError);
    const rejecting = { ...service, preparePrimaryRequestAdmission: () => Object.freeze({ kind: 'local_admission_failed', routePass: { kind: 'ordinary' as const, candidateChain: [CANDIDATE] }, candidates: Object.freeze([]), bindings: Object.freeze({}) }) } as unknown as InvocationService;
    await expect(executeAdmittedTurn(rejecting, input, new AbortController().signal)).rejects.toBeInstanceOf(LocalExactAdmissionError);
  });
});

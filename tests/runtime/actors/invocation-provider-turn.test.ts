import { describe, expect, it, jest } from '@jest/globals';
import { createInvocationProviderTurnPort } from '../../../src/runtime/actors/index.js';
import type { InvocationTurnService, LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { issueCompositionMutationAuthority } from '../../../src/application/mutation-authority.js';

function input(overrides: Partial<LlmInvocationInput> = {}): LlmInvocationInput {
  return {
    inputId: 'turn-1',
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt: 'plan',
    contextMessages: [],
    activeConversationReplay: { sessionId: 'planner:project', messages: [] },
    tools: [],
    terminalToolNames: ['report_done'],
    modelParams: { temperature: 0.2, maxTokens: 1000 },
    capabilityRequest: { requiresTools: true },
    episodeContext: { cardId: 'project' },
    ...overrides,
  };
}

describe('InvocationProviderTurnPort', () => {
  it('maps LlmInvocationInput to InvocationService.invokeWithRecovery', async () => {
    const service: InvocationTurnService = {
      invokeWithRecovery: jest.fn(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] })),
    };
    const port = createInvocationProviderTurnPort(service);
    const signal = new AbortController().signal;

    const mutationAuthority = issueCompositionMutationAuthority();
    const result = await port.completeTurn(input(), signal, mutationAuthority);

    expect(result).toEqual({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] });
    expect(service.invokeWithRecovery).toHaveBeenCalledWith({
      inputId: 'turn-1',
      mutationAuthority,
      role: 'planner',
      sessionId: 'planner:project',
      systemPrompt: 'plan',
      genericContextMessages: [],
      activeConversationReplay: { sessionId: 'planner:project', messages: [] },
      tools: [],
      terminalToolNames: ['report_done'],
      modelParams: { temperature: 0.2, maxTokens: 1000 },
      capabilityRequest: { requiresTools: true },
      abortSignal: signal,
    });
  });

  it('fails clearly on invalid context messages', async () => {
    const service: InvocationTurnService = {
      invokeWithRecovery: jest.fn(async () => ({ result: { kind: 'message' as const, content: 'unused' }, provider_exchanges: [] })),
    };
    const port = createInvocationProviderTurnPort(service);

    await expect(port.completeTurn(input({ contextMessages: [{ role: 'user' }] }), new AbortController().signal, issueCompositionMutationAuthority())).rejects.toThrow("Invalid LLM context messages for 'turn-1'");
    expect(service.invokeWithRecovery).not.toHaveBeenCalled();
  });
});

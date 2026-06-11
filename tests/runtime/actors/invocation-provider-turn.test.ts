import { describe, expect, it, jest } from '@jest/globals';
import { createInvocationProviderTurnPort } from '../../../src/runtime/actors/index.js';
import type { InvocationTurnService, LlmInvocationInput } from '../../../src/runtime/actors/index.js';

function input(overrides: Partial<LlmInvocationInput> = {}): LlmInvocationInput {
  return {
    inputId: 'turn-1',
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt: 'plan',
    contextMessages: [],
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
      invokeWithRecovery: jest.fn(async () => ({ kind: 'message' as const, content: 'done' })),
    };
    const port = createInvocationProviderTurnPort(service);

    const result = await port.completeTurn(input());

    expect(result).toEqual({ kind: 'message', content: 'done' });
    expect(service.invokeWithRecovery).toHaveBeenCalledWith({
      role: 'planner',
      sessionId: 'planner:project',
      systemPrompt: 'plan',
      contextMessages: [],
      tools: [],
      terminalToolNames: ['report_done'],
      modelParams: { temperature: 0.2, maxTokens: 1000 },
      capabilityRequest: { requiresTools: true },
    });
  });

  it('fails clearly on invalid context messages', async () => {
    const service: InvocationTurnService = {
      invokeWithRecovery: jest.fn(async () => ({ kind: 'message' as const, content: 'unused' })),
    };
    const port = createInvocationProviderTurnPort(service);

    await expect(port.completeTurn(input({ contextMessages: [{ role: 'user' }] }))).rejects.toThrow("Invalid LLM context messages for 'turn-1'");
    expect(service.invokeWithRecovery).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, jest } from '@jest/globals';
import { createInvocationProviderTurnPort } from '../../../src/runtime/actors/index.js';
import type { InvocationTurnService, LlmInvocationInput } from '../../../src/runtime/actors/index.js';
import { prepareCompaction } from '../../../src/runtime/actors/compaction/compactor.js';

function input(overrides: Record<string, unknown> = {}): LlmInvocationInput {
  return {
    inputId: 'turn-1',
    agentId: 'planner:project',
    role: 'planner',
    sessionId: 'planner:project',
    systemPrompt: 'plan',
    providerConversation: { sourceSessionId: 'planner:project', messages: [] },
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

    const result = await port.completeTurn(input(), signal);

    expect(result).toEqual({ result: { kind: 'message', content: 'done' }, provider_exchanges: [] });
    expect(service.invokeWithRecovery).toHaveBeenCalledWith({
      inputId: 'turn-1',
      role: 'planner',
      sessionId: 'planner:project',
      systemPrompt: 'plan',
      providerConversation: { sourceSessionId: 'planner:project', messages: [] },
      tools: [],
      terminalToolNames: ['report_done'],
      modelParams: { temperature: 0.2, maxTokens: 1000 },
      capabilityRequest: { requiresTools: true },
      abortSignal: signal,
    });
  });

  it('forwards prepared compaction without adding an ordinary maxTokens authority', async () => {
    const invokeWithRecovery = jest.fn<InvocationTurnService['invokeWithRecovery']>(async () => ({ result: { kind: 'message' as const, content: 'done' }, provider_exchanges: [] }));
    const service: InvocationTurnService = { invokeWithRecovery };
    const port = createInvocationProviderTurnPort(service);
    const preparedCompaction = prepareCompaction({ enabled: true, input_budget_tokens: 1000, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, escalate_merge_line_fraction: 0.4, escalate_summary_line_fraction: 0.55, snap: 'compact_straddler', summarizer_model: 'test/_/summary' }, 'plan', []);

    await port.completeTurn(input({ modelParams: {}, preparedCompaction }), new AbortController().signal);

    expect(service.invokeWithRecovery).toHaveBeenCalledWith(expect.objectContaining({ modelParams: {}, preparedCompaction }));
    expect(invokeWithRecovery.mock.calls[0]![0].capabilityRequest).not.toHaveProperty('requestedCompletionTokens');
  });
});

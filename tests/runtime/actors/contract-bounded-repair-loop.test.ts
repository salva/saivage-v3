import { describe, expect, it, jest } from '@jest/globals';

import { runContractBoundedRepairLoop } from '../../../src/runtime/actors/contract-bounded-repair-loop.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/llm-actor.js';

const plainTextOutcome: Extract<LLMActorOutcome, { type: 'result' }> = {
  type: 'result',
  agentId: 'agent-1',
  result: { kind: 'message', content: 'plain text' },
};

function terminalToolOutcome(id: string): Extract<LLMActorOutcome, { type: 'tool_call' }> {
  return { type: 'tool_call', agentId: 'agent-1', inputId: id, toolCallId: id, toolName: 'finish', args: {} };
}

describe('runContractBoundedRepairLoop', () => {
  it('bounds repeated terminal-contract repairs before failing', async () => {
    const fail = jest.fn<(message: string) => string>((message) => `failed: ${message}`);
    const next = jest.fn<() => Promise<LLMActorOutcome>>()
      .mockResolvedValueOnce(terminalToolOutcome('repair-1'))
      .mockResolvedValueOnce(terminalToolOutcome('repair-2'));

    const result = await runContractBoundedRepairLoop({
      initialOutcome: terminalToolOutcome('initial'),
      isTerminalToolName: (name) => name === 'finish',
      fail,
      onPlainText: () => ({ kind: 'done', value: 'unexpected plain text' }),
      onTerminalTool: (_outcome, control) => control.repair('terminal contract invalid', next),
      onNonTerminalTool: async () => plainTextOutcome,
    });

    expect(result).toEqual({ kind: 'done', value: 'failed: terminal contract invalid' });
    expect(next).toHaveBeenCalledTimes(2);
    expect(fail).toHaveBeenCalledTimes(1);
  });

  it('routes non-terminal tools back through the loop', async () => {
    const result = await runContractBoundedRepairLoop({
      initialOutcome: { type: 'tool_call', agentId: 'agent-1', inputId: 'tool-1', toolCallId: 'tool-1', toolName: 'lookup', args: {} },
      isTerminalToolName: (name) => name === 'finish',
      fail: (message) => `failed: ${message}`,
      onPlainText: (outcome, control) => control.done(outcome.result.content),
      onTerminalTool: (_outcome, control) => control.done('terminal'),
      onNonTerminalTool: async () => plainTextOutcome,
    });

    expect(result).toEqual({ kind: 'done', value: 'plain text' });
  });

  it('returns restart as a first-class control result', async () => {
    const result = await runContractBoundedRepairLoop({
      initialOutcome: terminalToolOutcome('initial'),
      isTerminalToolName: (name) => name === 'finish',
      fail: (message) => `failed: ${message}`,
      onPlainText: (_outcome, control) => control.done('plain text'),
      onTerminalTool: (_outcome, control) => control.restart(),
      onNonTerminalTool: async () => plainTextOutcome,
    });

    expect(result).toEqual({ kind: 'restart' });
  });
});

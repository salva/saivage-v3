import { describe, expect, it, jest } from '@jest/globals';

import { runContractRepairLoop } from '../../../src/runtime/actors/contract-repair-loop.js';
import type { LLMActorOutcome } from '../../../src/runtime/actors/llm-actor.js';

const plainTextOutcome: Extract<LLMActorOutcome, { type: 'result' }> = {
  type: 'result',
  agentId: 'agent-1',
  result: { kind: 'message', content: 'plain text' },
};

function terminalToolOutcome(id: string): Extract<LLMActorOutcome, { type: 'tool_call' }> {
  return { type: 'tool_call', agentId: 'agent-1', inputId: id, toolCallId: id, toolName: 'finish', args: {} };
}

describe('runContractRepairLoop', () => {
  it('continues repeated terminal-contract repairs past the old cap', async () => {
    const fail = jest.fn<(message: string) => string>((message) => `failed: ${message}`);
    const next = jest.fn<() => Promise<LLMActorOutcome>>()
      .mockResolvedValueOnce(terminalToolOutcome('repair-1'))
      .mockResolvedValueOnce(terminalToolOutcome('repair-2'))
      .mockResolvedValueOnce(terminalToolOutcome('repair-3'))
      .mockResolvedValueOnce(terminalToolOutcome('repair-4'))
      .mockResolvedValueOnce(terminalToolOutcome('repair-5'));
    let terminalAttempts = 0;

    const result = await runContractRepairLoop({
      initialOutcome: terminalToolOutcome('initial'),
      isTerminalToolName: (name) => name === 'finish',
      fail,
      onPlainText: () => ({ kind: 'done', value: 'unexpected plain text' }),
      onTerminalTool: (_outcome, control) => {
        terminalAttempts++;
        if (terminalAttempts > 5) return control.done('accepted after repairs');
        return control.repair(next);
      },
      onNonTerminalTool: async () => plainTextOutcome,
    });

    expect(result).toEqual({ kind: 'done', value: 'accepted after repairs' });
    expect(next).toHaveBeenCalledTimes(5);
    expect(fail).not.toHaveBeenCalled();
  });

  it('fails fast for error outcomes', async () => {
    const fail = jest.fn<(message: string) => string>((message) => `failed: ${message}`);

    const result = await runContractRepairLoop({
      initialOutcome: { type: 'error', agentId: 'agent-1', error: 'provider unavailable' },
      isTerminalToolName: (name) => name === 'finish',
      fail,
      onPlainText: () => ({ kind: 'done', value: 'unexpected plain text' }),
      onTerminalTool: (_outcome, control) => control.done('terminal'),
      onNonTerminalTool: async () => plainTextOutcome,
    });

    expect(result).toEqual({ kind: 'done', value: 'failed: provider unavailable' });
    expect(fail).toHaveBeenCalledTimes(1);
    expect(fail).toHaveBeenCalledWith('provider unavailable');
  });

  it('routes non-terminal tools back through the loop', async () => {
    const result = await runContractRepairLoop({
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
    const result = await runContractRepairLoop({
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

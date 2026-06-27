import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { abandonStalePendingToolCalls, actorMessagesPath, appendLlmTurnFinished, appendLlmTurnStarted, appendTerminalToolProjectedStatus, readLoggedToolCall, readToolCallStatuses } from '../../../src/runtime/actors/index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/index.js';

function withTempProject<T>(fn: (projectRoot: string) => T): T {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-llm-delivery-log-'));
  try {
    initProjectTree(projectRoot);
    return fn(projectRoot);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}

function input(inputId = 'planner:G-1:1'): LlmInvocationInput {
  return {
    inputId,
    agentId: 'planner:G-1',
    role: 'planner',
    sessionId: 'planner:G-1',
    systemPrompt: 'system',
    contextMessages: [],
    tools: [],
    terminalToolNames: [],
    modelParams: {},
    capabilityRequest: {},
    episodeContext: { cardId: 'G-1' },
  };
}

function jsonl(path: string): Array<Record<string, unknown>> {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8').split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('llm delivery log recovery helpers', () => {
  it('logs the outbound system prompt before turn activity exactly once', () => withTempProject((projectRoot) => {
    appendLlmTurnStarted(projectRoot, input());
    appendLlmTurnStarted(projectRoot, input('planner:G-1:2'));

    const rows = jsonl(actorMessagesPath(projectRoot, 'planner:G-1'));
    expect(rows[0]).toMatchObject({ role: 'system', kind: 'system_prompt', content: 'system' });
    expect(rows.filter((entry) => entry.kind === 'system_prompt')).toHaveLength(1);
  }));

  it('reads an exact logged tool call by agent, input, and call id', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }] });

    expect(readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1:1', 'call-1')).toEqual({
      agent_id: 'planner:G-1',
      source_input_id: 'planner:G-1:1',
      tool_call_id: 'call-1',
      tool_name: 'emit_planner_result',
      args: { status: 'blocked', summary: 'blocked' },
    });
    const toolCallMessage = jsonl(actorMessagesPath(projectRoot, 'planner:G-1')).find((entry) => entry.kind === 'tool_call');
    expect(JSON.parse(String(toolCallMessage?.content))).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }],
    });
  }));

  it('throws when the logged tool call is missing', () => withTempProject((projectRoot) => {
    expect(() => readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1:1', 'missing')).toThrow(/not found/);
  }));

  it('throws when logged tool arguments are malformed JSON', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_planner_result', arguments: '{not json' } }] });

    expect(() => readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1:1', 'call-1')).toThrow(/malformed JSON/);
  }));

  it('treats terminal_projected status as terminal for stale pending abandonment', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_planner_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendTerminalToolProjectedStatus(projectRoot, { agent_id: 'planner:G-1', source_input_id: 'planner:G-1:1', tool_call_id: 'call-1', tool_name: 'emit_planner_result' });

    expect(abandonStalePendingToolCalls(projectRoot)).toEqual([]);
    expect(readToolCallStatuses(projectRoot, 'planner:G-1').map((record) => record.status)).toEqual(['pending', 'terminal_projected']);
  }));
});

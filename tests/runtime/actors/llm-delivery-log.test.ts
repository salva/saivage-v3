import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProjectTree } from '../../../src/persistence/file-tree.js';
import { abandonStalePendingToolCalls, appendConversationMessage, appendLlmTurnFinished, appendLlmTurnStarted, appendTerminalToolProjectedStatus, buildContextTextMessage, conversationIndexPath, conversationMessagesForModel, listConversationSessionIds, readLoggedToolCall, readToolCallStatuses } from '../../../src/runtime/actors/index.js';
import { activeVersionPath } from '../../../src/runtime/actors/conversation-index.js';
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
  it('logs the outbound system prompt before turn activity when requested', () => withTempProject((projectRoot) => {
    appendLlmTurnStarted(projectRoot, input());
    appendLlmTurnStarted(projectRoot, input('planner:G-1:2'), { includeSystemPrompt: false });

    expect(JSON.parse(readFileSync(conversationIndexPath(projectRoot, 'planner:G-1'), 'utf-8'))).toMatchObject({ schema_version: 2, active_version: 1 });
    const rows = jsonl(activeVersionPath(projectRoot, 'planner:G-1', 1));
    expect(rows[0]).toMatchObject({ role: 'system', kind: 'system_prompt', content: 'system' });
    expect(rows.filter((entry) => entry.kind === 'system_prompt')).toHaveLength(1);
  }));

  it('reads an exact logged tool call by agent, input, and call id', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }] });

    expect(readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1', 'planner:G-1:1', 'call-1')).toEqual({
      agent_id: 'planner:G-1',
      source_input_id: 'planner:G-1:1',
      tool_call_id: 'call-1',
      tool_name: 'emit_result',
      args: { status: 'blocked', summary: 'blocked' },
    });
    const toolCallMessage = jsonl(activeVersionPath(projectRoot, 'planner:G-1', 1)).find((entry) => entry.kind === 'tool_call');
    expect(JSON.parse(String(toolCallMessage?.content))).toEqual({
      role: 'assistant',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }],
    });
  }));

  it('throws when the logged tool call is missing', () => withTempProject((projectRoot) => {
    expect(() => readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1', 'planner:G-1:1', 'missing')).toThrow(/not found/);
  }));

  it('throws when logged tool arguments are malformed JSON', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: '{not json' } }] });

    expect(() => readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1', 'planner:G-1:1', 'call-1')).toThrow(/malformed JSON/);
  }));

  it('reads reviewer tool calls by session when session differs from agent id', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, { ...input('reviewer:G-1:1'), agentId: 'reviewer:G-1', role: 'reviewer', sessionId: 'reviewer:G-1:assessment-G-1-1' }, { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done', summary: 'ok' }) } }] });

    expect(readLoggedToolCall(projectRoot, 'reviewer:G-1:assessment-G-1-1', 'reviewer:G-1', 'reviewer:G-1:1', 'call-1')).toMatchObject({
      agent_id: 'reviewer:G-1',
      tool_name: 'emit_result',
    });
    expect(() => readLoggedToolCall(projectRoot, 'reviewer:G-1', 'reviewer:G-1', 'reviewer:G-1:1', 'call-1')).toThrow(/not found/);
  }));

  it('treats terminal_projected status as terminal for stale pending abandonment', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(projectRoot, input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendTerminalToolProjectedStatus(projectRoot, { agent_id: 'planner:G-1', source_input_id: 'planner:G-1:1', tool_call_id: 'call-1', tool_name: 'emit_result' });

    expect(abandonStalePendingToolCalls(projectRoot)).toEqual([]);
    expect(readToolCallStatuses(projectRoot, 'planner:G-1').map((record) => record.status)).toEqual(['pending', 'terminal_projected']);
  }));

  it('lists encoded conversation session directories as decoded ids', () => withTempProject((projectRoot) => {
    appendConversationMessage(projectRoot, buildContextTextMessage('reviewer:G-1:assessment 1', 'user', 'hello'));
    appendConversationMessage(projectRoot, buildContextTextMessage('analyst:global', 'user', 'hello'));

    expect(listConversationSessionIds(projectRoot)).toEqual(['analyst:global', 'reviewer:G-1:assessment 1']);
  }));

  it('builds valid provider-visible caller context rows', () => withTempProject((projectRoot) => {
    const message = buildContextTextMessage('analyst:global', 'system', '[workspace-context]');
    appendConversationMessage(projectRoot, message);

    expect(message).toMatchObject({ session_id: 'analyst:global', role: 'system', kind: 'text', content: '[workspace-context]' });
    expect(message.id).toContain('analyst:global:context:');
    expect(message.round_id).toMatch(/^r-pre-/);
    expect(jsonl(activeVersionPath(projectRoot, 'analyst:global', 1))).toHaveLength(1);
  }));

  it('projects only provider-visible conversation messages for model reconstruction', () => withTempProject((projectRoot) => {
    const sessionId = 'planner:G-1';
    appendLlmTurnStarted(projectRoot, input());
    appendLlmTurnFinished(projectRoot, input(), { kind: 'message', content: 'assistant text' });
    appendConversationMessage(projectRoot, { ...buildContextTextMessage(sessionId, 'user', 'repair'), id: 'repair', kind: 'model_repair' });
    appendConversationMessage(projectRoot, { ...buildContextTextMessage(sessionId, 'system', 'issue'), id: 'issue', kind: 'model_issue' });

    expect(conversationMessagesForModel(jsonl(activeVersionPath(projectRoot, sessionId, 1)) as never).map((message) => message.kind)).toEqual(['text', 'model_repair']);
  }));
});

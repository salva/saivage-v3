import { initProjectTree, testCompositionAuthority } from '../../helpers/canonical-project.js';
import { describe, expect, it } from '@jest/globals';
import { appendTestConversationMessage as appendConversationMessage, testConversationMutations, writeTestCompactedConversationVersion as writeCompactedConversationVersion } from '../../helpers/conversation-mutations.js';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { abandonStalePendingToolCalls as productionAbandonStalePendingToolCalls, appendLlmTurnFinished as productionAppendLlmTurnFinished, appendLlmTurnMessageBatch, appendLlmTurnStarted as productionAppendLlmTurnStarted, appendTerminalProjectedToolResult as productionAppendTerminalProjectedToolResult, appendToolErrorSettlementResults as productionAppendToolErrorSettlementResults, loggedToolCallKey, readLoggedToolCall, sourceInputIdFromToolCallMessageId, sourceInputIdFromToolErrorMessageId, sourceInputIdFromToolResultMessageId } from '../../../src/runtime/actors/llm-delivery-log.js';
import { buildContextTextMessage, conversationIndexPath, conversationMessagesForModel, listConversationSessionIds, readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';
import { activeVersionPath } from '../../../src/runtime/actors/conversation-index.js';
import type { LlmInvocationInput } from '../../../src/runtime/actors/llm-invocation.js';

const appendLlmTurnStarted = (conversations: ReturnType<typeof testConversationMutations>, input: LlmInvocationInput, options?: { includeSystemPrompt?: boolean }) => productionAppendLlmTurnStarted(conversations, testCompositionAuthority(conversations.projectRoot), input, options);
const appendLlmTurnFinished = (conversations: ReturnType<typeof testConversationMutations>, input: LlmInvocationInput, result: Parameters<typeof productionAppendLlmTurnFinished>[3]) => productionAppendLlmTurnFinished(conversations, testCompositionAuthority(conversations.projectRoot), input, result);
const appendTerminalProjectedToolResult = (conversations: ReturnType<typeof testConversationMutations>, record: Parameters<typeof productionAppendTerminalProjectedToolResult>[2]) => productionAppendTerminalProjectedToolResult(conversations, testCompositionAuthority(conversations.projectRoot), record);
const appendToolErrorSettlementResults = (projectRoot: string, conversations: ReturnType<typeof testConversationMutations>) => productionAppendToolErrorSettlementResults(projectRoot, conversations, testCompositionAuthority(projectRoot));
const abandonStalePendingToolCalls = (projectRoot: string, conversations: ReturnType<typeof testConversationMutations>, reason?: string, preserveKeys?: ReadonlySet<string>) => productionAbandonStalePendingToolCalls(projectRoot, conversations, testCompositionAuthority(projectRoot), reason, preserveKeys);

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

function appendToolError(projectRoot: string, sessionId: string, sourceInputId: string, toolCallId: string, tool = 'emit_result', content = 'tool failed'): void {
  appendConversationMessage(projectRoot, {
    id: `${sourceInputId}:tool-error:${toolCallId}`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_error',
    content,
    tool,
    tool_call_id: toolCallId,
    round_id: 'r-user-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    message_index: 2,
    block_index: 0,
    timestamp: new Date().toISOString(),
  });
}

function toolResults(projectRoot: string, sessionId: string): AgentToolResult[] {
  return readConversationMessages(projectRoot, sessionId).filter((message) => message.kind === 'tool_result') as AgentToolResult[];
}

type AgentToolResult = ReturnType<typeof readConversationMessages>[number] & { kind: 'tool_result' };

describe('llm delivery log recovery helpers', () => {
  it('commits OpenAI Responses private and visible rows as one idempotent batch', () => withTempProject((projectRoot) => {
    const conversations = testConversationMutations(projectRoot);
    const turn = input('planner:G-1:responses');
    const privateContext = { kind: 'openai_responses' as const, source_input_id: turn.inputId, provider: 'openai', model: 'gpt-5.6', output: [{ type: 'reasoning', encrypted_content: 'opaque' }] };
    expect(appendLlmTurnMessageBatch(conversations, testCompositionAuthority(projectRoot), turn, 'visible', privateContext).appendResult.appended).toBe(true);
    expect(appendLlmTurnMessageBatch(conversations, testCompositionAuthority(projectRoot), turn, 'visible', privateContext).appendResult.appended).toBe(false);
    expect(readConversationMessages(projectRoot, turn.sessionId).map((row) => row.kind)).toEqual(['provider_private', 'text']);
  }));
  it('logs the outbound system prompt before turn activity when requested', () => withTempProject((projectRoot) => {
    appendLlmTurnStarted(testConversationMutations(projectRoot), input());
    appendLlmTurnStarted(testConversationMutations(projectRoot), input('planner:G-1:2'), { includeSystemPrompt: false });

    expect(JSON.parse(readFileSync(conversationIndexPath(projectRoot, 'planner:G-1'), 'utf-8'))).toMatchObject({ schema_version: 2, active_version: 1 });
    const rows = jsonl(activeVersionPath(projectRoot, 'planner:G-1', 1));
    expect(rows[0]).toMatchObject({ role: 'system', kind: 'system_prompt', content: 'system' });
    expect(rows.filter((entry) => entry.kind === 'system_prompt')).toHaveLength(1);
  }));

  it('reads an exact logged tool call by agent, input, and call id', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked', summary: 'blocked' }) } }] });

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
    appendLlmTurnFinished(testConversationMutations(projectRoot), input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: '{not json' } }] });

    expect(() => readLoggedToolCall(projectRoot, 'planner:G-1', 'planner:G-1', 'planner:G-1:1', 'call-1')).toThrow(/malformed JSON/);
  }));

  it('reads reviewer tool calls by session when session differs from agent id', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), { ...input('reviewer:G-1:1'), agentId: 'reviewer:G-1', role: 'reviewer', sessionId: 'reviewer:G-1:assessment-G-1-1' }, { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done', summary: 'ok' }) } }] });

    expect(readLoggedToolCall(projectRoot, 'reviewer:G-1:assessment-G-1-1', 'reviewer:G-1', 'reviewer:G-1:1', 'call-1')).toMatchObject({
      agent_id: 'reviewer:G-1',
      tool_name: 'emit_result',
    });
    expect(() => readLoggedToolCall(projectRoot, 'reviewer:G-1', 'reviewer:G-1', 'reviewer:G-1:1', 'call-1')).toThrow(/not found/);
  }));

  it('treats terminal-projected tool_result as terminal for stale pending abandonment', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input(), { kind: 'tool_calls', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendTerminalProjectedToolResult(testConversationMutations(projectRoot), { sessionId: 'planner:G-1', sourceInputId: 'planner:G-1:1', toolCallId: 'call-1', toolName: 'emit_result' });

    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot))).toEqual([]);
    expect(readConversationMessages(projectRoot, 'planner:G-1').filter((message) => message.kind === 'tool_result')).toEqual([
      expect.objectContaining({ id: 'planner:G-1:1:tool:0:tool-result:call-1', tool_call_id: 'call-1', content: JSON.stringify({ projected: true }) }),
    ]);
  }));

  it('writes reviewer terminal projection to the passed reviewer session id', () => withTempProject((projectRoot) => {
    const sessionId = 'reviewer:G-1:assessment-G-1-1';
    appendLlmTurnFinished(testConversationMutations(projectRoot), { ...input('reviewer:G-1:1'), agentId: 'reviewer:G-1', role: 'reviewer', sessionId }, { kind: 'tool_calls', tool_calls: [{ id: 'call-review', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done', summary: 'ok' }) } }] });
    appendTerminalProjectedToolResult(testConversationMutations(projectRoot), { sessionId, sourceInputId: 'reviewer:G-1:1', toolCallId: 'call-review', toolName: 'emit_result' });

    expect(readConversationMessages(projectRoot, sessionId).filter((message) => message.kind === 'tool_result')).toEqual([
      expect.objectContaining({ id: 'reviewer:G-1:1:tool:0:tool-result:call-review', tool_call_id: 'call-review', content: JSON.stringify({ projected: true }) }),
    ]);
    expect(readConversationMessages(projectRoot, 'reviewer:G-1').filter((message) => message.kind === 'tool_result')).toEqual([]);
    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot))).toEqual([]);
  }));

  it('matches settlement by session, source input, and tool call id', () => withTempProject((projectRoot) => {
    const sessionId = 'planner:G-1';
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call_dup', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:2'), { kind: 'tool_calls', tool_calls: [{ id: 'call_dup', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done' }) } }] });
    appendConversationMessage(projectRoot, {
      id: 'planner:G-1:2:tool:1:tool-result:call_dup',
      session_id: sessionId,
      role: 'tool',
      kind: 'tool_result',
      content: JSON.stringify({ success: true }),
      tool: 'emit_result',
      tool_call_id: 'call_dup',
      round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      message_index: 2,
      block_index: 0,
      timestamp: new Date().toISOString(),
    });

    const incidents = abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale');
    expect(incidents.map((incident) => incident.source_input_id)).toEqual(['planner:G-1:1']);
    const toolResults = readConversationMessages(projectRoot, sessionId).filter((message) => message.kind === 'tool_result');
    expect(toolResults).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'planner:G-1:1:tool:0:tool-result:call_dup', content: JSON.stringify({ success: false, error: 'stale', data: { tool: 'emit_result' } }) }),
      expect.objectContaining({ id: 'planner:G-1:2:tool:1:tool-result:call_dup', content: JSON.stringify({ success: true }) }),
    ]));
    expect(toolResults.some((message) => message.id === 'planner:G-1:2:tool:0:tool-result:call_dup')).toBe(false);
  }));

  it('ignores inactive-version tool calls after compaction when abandoning stale calls', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call-frozen', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    writeCompactedConversationVersion({
      projectRoot,
      sessionId: 'planner:G-1',
      sourceVersion: 1,
      content: '',
      compactedThrough: { message_id: 'summary', round_id: 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', timestamp: new Date().toISOString() },
      summaryIds: [],
      compactionGeneration: 1,
      bands: { merge_line: 1, summary_line: 1, trigger: 1, snap: 'keep_straddler_verbatim' },
    });

    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot))).toEqual([]);
    expect(jsonl(activeVersionPath(projectRoot, 'planner:G-1', 2))).toEqual([]);
  }));

  it('appends provider-visible failed results for valid tool_error-only settlements', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call-error', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendToolError(projectRoot, 'planner:G-1', 'planner:G-1:1', 'call-error', 'emit_result', 'provider-side tool failure');

    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot))).toEqual([]);
    const settled = appendToolErrorSettlementResults(projectRoot, testConversationMutations(projectRoot));
    expect(settled).toEqual([expect.objectContaining({ source_input_id: 'planner:G-1:1', tool_call_id: 'call-error', error: 'provider-side tool failure' })]);
    expect(appendToolErrorSettlementResults(projectRoot, testConversationMutations(projectRoot))).toEqual([]);
    const results = toolResults(projectRoot, 'planner:G-1');
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: 'planner:G-1:1:tool:0:tool-result:call-error', tool_call_id: 'call-error' });
    expect(JSON.parse(results[0]!.content)).toMatchObject({ success: false, error: 'provider-side tool failure', data: { tool: 'emit_result' } });
    expect(conversationMessagesForModel(readConversationMessages(projectRoot, 'planner:G-1')).map((message) => message.kind)).toEqual(['tool_call', 'tool_result']);
  }));

  it('matches tool_error settlements by full source-input triple and leaves collisions dangling', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call_dup', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:2'), { kind: 'tool_calls', tool_calls: [{ id: 'call_dup', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'done' }) } }] });
    appendToolError(projectRoot, 'planner:G-1', 'planner:G-1:2', 'call_dup');

    expect(appendToolErrorSettlementResults(projectRoot, testConversationMutations(projectRoot)).map((record) => record.source_input_id)).toEqual(['planner:G-1:2']);
    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale').map((record) => record.source_input_id)).toEqual(['planner:G-1:1']);
    expect(toolResults(projectRoot, 'planner:G-1').map((message) => message.id).sort()).toEqual([
      'planner:G-1:1:tool:0:tool-result:call_dup',
      'planner:G-1:2:tool:0:tool-result:call_dup',
    ]);
  }));

  it('fails fast on invalid tool_error rows during active-version settlement reads', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call-invalid-error', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendFileSync(activeVersionPath(projectRoot, 'planner:G-1', 1), `${JSON.stringify({
      id: 'planner:G-1:1:tool-error:call-invalid-error',
      session_id: 'planner:G-1',
      role: 'tool',
      kind: 'tool_error',
      content: 'invalid row',
      tool_call_id: 'call-invalid-error',
      round_id: 'r-user-cccccccccccccccccccccccccccccccc',
      message_index: 2,
      block_index: 0,
      timestamp: new Date().toISOString(),
    })}\n`);

    expect(() => appendToolErrorSettlementResults(projectRoot, testConversationMutations(projectRoot))).toThrow(/tool_error rows require tool/);
    expect(() => abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale')).toThrow(/tool_error rows require tool/);
    expect(jsonl(activeVersionPath(projectRoot, 'planner:G-1', 1)).some((row) => row.kind === 'tool_result')).toBe(false);
  }));

  it('skips Analyst active versions before both global settlement reads while settling autonomous sessions', () => withTempProject((projectRoot) => {
    appendConversationMessage(projectRoot, buildContextTextMessage('analyst:global', 'user', 'do not read this'));
    writeFileSync(activeVersionPath(projectRoot, 'analyst:global', 1), '{"malformed"\n', 'utf8');
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call-error', type: 'function', function: { name: 'emit_result', arguments: JSON.stringify({ status: 'blocked' }) } }] });
    appendToolError(projectRoot, 'planner:G-1', 'planner:G-1:1', 'call-error');
    const reviewerSession = 'reviewer:G-1:assessment-G-1-1';
    appendLlmTurnFinished(testConversationMutations(projectRoot), { ...input('reviewer:G-1:1'), agentId: 'reviewer:G-1', role: 'reviewer', sessionId: reviewerSession }, { kind: 'tool_calls', tool_calls: [{ id: 'call-dangling', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });

    expect(appendToolErrorSettlementResults(projectRoot, testConversationMutations(projectRoot))).toEqual([expect.objectContaining({ agent_id: 'planner:G-1', tool_call_id: 'call-error' })]);
    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale')).toEqual([expect.objectContaining({ agent_id: 'reviewer:G-1', tool_call_id: 'call-dangling' })]);
    expect(readFileSync(activeVersionPath(projectRoot, 'analyst:global', 1), 'utf8')).toBe('{"malformed"\n');
    expect(toolResults(projectRoot, 'planner:G-1')).toHaveLength(1);
    expect(toolResults(projectRoot, reviewerSession)).toHaveLength(1);
  }));

  it('emits actionable payloads for activation, process, workspace, and generic interrupted calls', () => withTempProject((projectRoot) => {
    const calls = [
      { id: 'call-activate', name: 'activate_card', args: { child_card_id: 'code-1' } },
      { id: 'call-process', name: 'wait_process', args: { process_id: 'proc-1' } },
      { id: 'call-workspace', name: 'write_file', args: { path: 'src/index.ts' } },
      { id: 'call-generic', name: 'custom_tool', args: { value: true } },
    ];
    calls.forEach((call, index) => appendLlmTurnFinished(testConversationMutations(projectRoot), input(`planner:G-1:${index + 1}`), { kind: 'tool_calls', tool_calls: [{ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }));

    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale')).toHaveLength(4);
    const payloads = Object.fromEntries(toolResults(projectRoot, 'planner:G-1').map((message) => [message.tool_call_id, JSON.parse(message.content)]));
    expect(payloads['call-activate']).toMatchObject({ success: false, data: { tool: 'activate_card', child_card_id: 'code-1', instruction: 'inspect child card state before retrying' } });
    expect(payloads['call-process']).toMatchObject({ success: false, data: { tool: 'wait_process', process_id: 'proc-1', instruction: 'process no longer exists, launch a new one if needed' } });
    expect(payloads['call-workspace']).toMatchObject({ success: false, data: { tool: 'write_file', target_path: 'src/index.ts' } });
    expect(payloads['call-generic']).toEqual({ success: false, error: 'stale', data: { tool: 'custom_tool' } });
  }));

  it('preserves relinked activation triples during interrupted settlement', () => withTempProject((projectRoot) => {
    appendLlmTurnFinished(testConversationMutations(projectRoot), input('planner:G-1:1'), { kind: 'tool_calls', tool_calls: [{ id: 'call-preserved-activation', type: 'function', function: { name: 'activate_card', arguments: JSON.stringify({ child_card_id: 'code-1' }) } }] });
    const preserve = new Set([loggedToolCallKey({ session_id: 'planner:G-1', source_input_id: 'planner:G-1:1', tool_call_id: 'call-preserved-activation' })]);

    expect(abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale', preserve)).toEqual([]);
    expect(toolResults(projectRoot, 'planner:G-1')).toEqual([]);
  }));

  it('preserves reviewer pending tool calls by session-scoped key', () => withTempProject((projectRoot) => {
    const sessionId = 'reviewer:G-1:assessment-G-1-1';
    appendLlmTurnFinished(testConversationMutations(projectRoot), { ...input('reviewer:G-1:1'), agentId: 'reviewer:G-1', role: 'reviewer', sessionId }, { kind: 'tool_calls', tool_calls: [{ id: 'call-preserve', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });

    const incidents = abandonStalePendingToolCalls(projectRoot, testConversationMutations(projectRoot), 'stale', new Set([loggedToolCallKey({ session_id: sessionId, source_input_id: 'reviewer:G-1:1', tool_call_id: 'call-preserve' })]));

    expect(incidents).toEqual([]);
    expect(readConversationMessages(projectRoot, sessionId).filter((message) => message.kind === 'tool_result')).toEqual([]);
  }));

  it('extracts source input ids from tool message ids and fails fast on malformed ids', () => {
    expect(sourceInputIdFromToolCallMessageId('planner:G-1:1:tool-call:call_dup')).toBe('planner:G-1:1');
    expect(sourceInputIdFromToolResultMessageId('planner:G-1:2:tool:1:tool-result:call_dup')).toBe('planner:G-1:2');
    expect(sourceInputIdFromToolErrorMessageId('planner:G-1:3:tool-error:call_dup', 'call_dup')).toBe('planner:G-1:3');
    expect(() => sourceInputIdFromToolCallMessageId('planner:G-1:1')).toThrow(/Malformed tool_call/);
    expect(() => sourceInputIdFromToolResultMessageId('planner:G-1:2:tool:1')).toThrow(/Malformed tool_result/);
    expect(() => sourceInputIdFromToolResultMessageId('planner:G-1:2:tool-result:call_dup')).toThrow(/delivery input/);
    expect(() => sourceInputIdFromToolErrorMessageId('planner:G-1:3:tool-error:call_dup', 'other')).toThrow(/Malformed tool_error/);
    expect(() => sourceInputIdFromToolErrorMessageId('planner:G-1:3:tool-error:', '')).toThrow(/missing tool_call_id/);
  });

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
    appendLlmTurnStarted(testConversationMutations(projectRoot), input());
    appendLlmTurnFinished(testConversationMutations(projectRoot), input(), { kind: 'message', content: 'assistant text' });
    appendConversationMessage(projectRoot, { ...buildContextTextMessage(sessionId, 'user', 'repair'), id: 'repair', kind: 'model_repair' });
    appendConversationMessage(projectRoot, { ...buildContextTextMessage(sessionId, 'system', 'issue'), id: 'issue', kind: 'model_issue' });

    expect(conversationMessagesForModel(jsonl(activeVersionPath(projectRoot, sessionId, 1)) as never).map((message) => message.kind)).toEqual(['text', 'model_repair']);
  }));
});

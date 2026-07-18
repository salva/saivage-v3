import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type MessageKind, type MessageRole, type ConversationSessionId } from '../../../src/schemas/index.js';
import { classifyConversation, ReconstructedActivationResultAppendError, stabilizeRoleSession } from '../../../src/runtime/actors/conversation-recovery.js';
import { hashConversationRows, validateConversationRows } from '../../../src/contracts/conversation-compaction.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { initProjectTree } from '../../helpers/canonical-project.js';

const terminalTools = new Set(['emit_result']);

function message(overrides: Partial<AgentMessage> & { kind: MessageKind; id?: string; role?: MessageRole }): AgentMessage {
  return {
    id: overrides.id ?? `${overrides.kind}-1`,
    session_id: overrides.session_id ?? 'planner:project',
    role: overrides.role ?? 'system',
    kind: overrides.kind,
    content: overrides.content ?? '',
    round_id: overrides.round_id ?? 'r-user-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    message_index: overrides.message_index ?? 0,
    block_index: overrides.block_index ?? 0,
    timestamp: overrides.timestamp ?? '2026-07-08T00:00:00.000Z',
    tool: overrides.tool,
    tool_call_id: overrides.tool_call_id,
  };
}

function toolCall(sourceInputId: string, toolCallId: string, sessionId: ConversationSessionId = 'planner:project', tool = 'emit_result'): AgentMessage {
  return message({
    id: `${sourceInputId}:tool-call:${toolCallId}`,
    session_id: sessionId,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: toolCallId, type: 'function', function: { name: tool, arguments: '{}' } }] }),
  });
}

function toolResult(sourceInputId: string, toolCallId: string, sessionId: ConversationSessionId = 'planner:project', tool = 'emit_result', result: unknown = { success: true }): AgentMessage {
  return message({
    id: `${sourceInputId}:tool-result:${toolCallId}`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_result',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify(result),
  });
}

describe('classifyConversation', () => {
  it('returns the six implicit states', () => {
    expect(classifyConversation([], terminalTools)).toBe('empty');
    expect(classifyConversation([message({ kind: 'system_prompt', role: 'system' })], terminalTools)).toBe('system_prompt_only');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:1', 'call-1')], terminalTools)).toBe('settled_terminal');
    expect(classifyConversation([message({ kind: 'text', role: 'assistant', content: 'plain text' })], terminalTools)).toBe('assistant_text_pending');
    expect(classifyConversation([message({ kind: 'model_repair', role: 'user', content: 'repair' })], terminalTools)).toBe('pending_provider');
  });

  it('defines dispositions for every message kind', () => {
    expect(classifyConversation([message({ kind: 'activity' })], terminalTools)).toBe('empty');
    expect(classifyConversation([message({ kind: 'model_issue' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_repair' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'context_compaction' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'model_recovered' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([message({ kind: 'text', role: 'user' })], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:1', 'call-1')], terminalTools)).toBe('settled_terminal');
    expect(classifyConversation([message({ kind: 'system_prompt' }), message({ kind: 'activity' })], terminalTools)).toBe('system_prompt_only');
  });

  it('classifies a strictly validated current-format compaction row as pending_provider', () => {
    const source = agentMessageSchema.parse(message({ id: 'activation', kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-07-08T00:00:00.000Z' }) }));
    const payload = contextCompactionContentSchema.parse({ boundary: 'round', retained_static_message_ids: [], summaries: [{ kind: 'individual', rounds: [{ complete: true, segments: [{ kind: 'initial', source_message_ids: [source.id] }] }], content_hash: hashConversationRows([source]), summary_text: 'summary', evidence: [] }], applied_policy: { mode: 'normal', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 10, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' } });
    const metadata = agentMessageSchema.parse(message({ id: 'compaction', kind: 'context_compaction', content: canonicalJson(payload), round_id: 'r-compacted-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }));
    const validated = validateConversationRows(source.session_id, [source, metadata]);
    expect(classifyConversation(validated.physicalRows, terminalTools)).toBe('pending_provider');
    expect(() => validateConversationRows(source.session_id, [source, { ...metadata, content: canonicalJson({ ...payload, summaries: [{ ...payload.summaries[0]!, content_hash: '0'.repeat(64) }] }) }])).toThrow(/hash mismatch/);
  });

  it('matches tool settlements by full session, source input, and tool call id', () => {
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolCall('planner:G-1:2', 'call-dup', 'planner:project', 'read_file'),
      toolResult('planner:G-1:2', 'call-dup', 'planner:project', 'read_file'),
    ], terminalTools)).toBe('pending_provider');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-dup'),
      toolResult('planner:G-1:2', 'call-dup'),
    ], terminalTools)).toBe('awaiting_tool_result');

    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1', 'planner:project'),
      toolResult('planner:G-1:1', 'call-1', 'reviewer:project'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('treats a failed tool_result as a settlement without changing its payload', () => {
    const result = toolResult('planner:G-1:1', 'call-1', 'planner:project', 'emit_result', { success: false, error: 'tool failed' });
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), result], terminalTools)).toBe('settled_terminal');
    expect(result.content).toBe('{"success":false,"error":"tool failed"}');
  });

  it('fails fast on malformed tool_result rows and does not match valid rows for other triples', () => {
    expect(() => classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      { ...toolResult('planner:G-1:1', 'call-1'), id: 'planner:G-1:1:result:call-1' },
    ], terminalTools)).toThrow(/Malformed tool_result/);
    expect(classifyConversation([
      toolCall('planner:G-1:1', 'call-1'),
      toolResult('planner:G-1:1', 'call-2'),
    ], terminalTools)).toBe('awaiting_tool_result');
  });

  it('requires a terminal-named tool_call plus matching model-visible tool_result for settled_terminal', () => {
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1', 'planner:project', 'read_file'), toolResult('planner:G-1:1', 'call-1', 'planner:project', 'read_file')], terminalTools)).toBe('pending_provider');
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), toolResult('planner:G-1:2', 'call-1')], terminalTools)).toBe('awaiting_tool_result');
  });
});

describe('reconstructed child-barrier stabilization', () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

  function scenario(call: { embeddedId?: string; embeddedName?: string; topName?: string; args?: unknown; rawContent?: string } = {}) {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-reconstructed-settlement-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const sessionId = 'planner:project' as const;
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    const toolCallId = 'call-1';
    const topName = call.topName ?? 'activate_card';
    appendConversationBatch(projectRoot, [
      message({ id: `${sessionId}:activation:one`, session_id: sessionId, kind: 'activity', content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: sourceInputId, timestamp: '2026-07-08T00:00:00.000Z' }) }),
      message({
        id: `${sourceInputId}:tool-call:${toolCallId}`,
        session_id: sessionId,
        role: 'assistant',
        kind: 'tool_call',
        tool: topName,
        tool_call_id: toolCallId,
        content: call.rawContent ?? JSON.stringify({ role: 'assistant', tool_calls: [{ id: call.embeddedId ?? toolCallId, type: 'function', function: { name: call.embeddedName ?? topName, arguments: JSON.stringify(call.args ?? { card_id: 'card-a' }) } }] }),
      }),
    ]);
    return { projectRoot, sessionId, sourceInputId, toolCallId };
  }

  function stabilize(projectRoot: string, signal = new AbortController().signal) {
    return stabilizeRoleSession({
      projectRoot,
      sessionId: 'planner:project',
      conversations: { projectRoot },
      terminalToolNames: terminalTools,
      reconstructedSettlement: { kind: 'reconstructed_barrier', childCardId: 'card-a', outcome: { status: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } } },
      signal,
    });
  }

  it('strictly associates and appends the complete real result once', () => {
    const { projectRoot, sourceInputId, toolCallId } = scenario();
    expect(stabilize(projectRoot).disposition).toBe('reconstructed_barrier');
    const result = readConversation(projectRoot, 'planner:project').physicalRows.at(-1)!;
    expect(result).toMatchObject({ id: `${sourceInputId}:tool-result:${toolCallId}`, tool: 'activate_card', tool_call_id: toolCallId });
    expect(JSON.parse(result.content)).toEqual({ success: true, data: { card_id: 'card-a', outcome: 'done', summary: 'child done', result: { kind: 'done', summary: 'child done' } } });
  });

  const invalidCalls: Array<[string, { embeddedId?: string; embeddedName?: string; topName?: string; args?: unknown; rawContent?: string }, RegExp]> = [
    ['embedded id mismatch', { embeddedId: 'call-other' }, /embedded id does not match/],
    ['embedded name mismatch', { embeddedName: 'read' }, /embedded name does not match/],
    ['wrong tool', { topName: 'read' }, /is not activate_card/],
    ['wrong child', { args: { card_id: 'card-b' } }, /not immediate child/],
    ['extra argument', { args: { card_id: 'card-a', extra: true } }, /unrecognized_keys/],
    ['missing card id', { args: {} }, /Required/],
    ['invalid card id', { args: { card_id: 'not-a-card' } }, /Expected a hierarchical card id/],
    ['malformed embedded payload', { rawContent: '{' }, /malformed content/],
  ];

  it.each(invalidCalls)('rejects %s without appending a result', (_name, call, expected) => {
    const { projectRoot } = scenario(call);
    expect(() => stabilize(projectRoot)).toThrow(expected);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(2);
  });

  it('rejects an absent unmatched barrier instead of falling back to clean recovery', () => {
    const { projectRoot } = scenario();
    const rows = readConversation(projectRoot, 'planner:project').physicalRows;
    appendConversationBatch(projectRoot, [message({
      id: '11111111-1111-4111-8111-111111111111:tool-result:call-1', session_id: 'planner:project', role: 'tool', kind: 'tool_result', tool: 'activate_card', tool_call_id: 'call-1',
      content: JSON.stringify({ success: false, error: 'already settled' }), message_index: 2,
    })]);
    expect(rows).toHaveLength(2);
    expect(() => stabilize(projectRoot)).toThrow(/no unmatched tool call/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });

  it('rejects multiple unmatched calls without appending any settlement', () => {
    const { projectRoot } = scenario();
    appendConversationBatch(projectRoot, [message({
      id: '11111111-1111-4111-8111-111111111111:tool-call:call-2', session_id: 'planner:project', role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-2',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'read', arguments: '{}' } }] }), message_index: 2,
    })]);
    expect(() => stabilize(projectRoot)).toThrow(/more than one unmatched tool call/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });

  it('rejects an unmatched call from an older activation round', () => {
    const { projectRoot } = scenario();
    appendConversationBatch(projectRoot, [message({
      id: 'planner:project:activation:two', session_id: 'planner:project', kind: 'activity',
      content: JSON.stringify({ event: 'activation_open', role: 'planner', card_id: 'project', input_id: '22222222-2222-4222-8222-222222222222', timestamp: '2026-07-08T00:00:01.000Z' }), round_id: 'r-pre-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message_index: 0, timestamp: '2026-07-08T00:00:01.000Z',
    })]);
    expect(() => stabilize(projectRoot)).toThrow(/older activation round/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });

  it('ordinary stabilization remains outcome-unknown and a clean repeat appends nothing', () => {
    const { projectRoot } = scenario({ topName: 'glob', args: { pattern: '**/*' } });
    const first = stabilizeRoleSession({ projectRoot, sessionId: 'planner:project', conversations: { projectRoot }, terminalToolNames: terminalTools });
    expect(first.disposition).toBe('ordinary_interruption');
    expect(JSON.parse(readConversation(projectRoot, 'planner:project').physicalRows.at(-1)!.content)).toMatchObject({ success: false, data: { outcome_unknown: true } });
    const count = readConversation(projectRoot, 'planner:project').physicalRows.length;
    expect(stabilizeRoleSession({ projectRoot, sessionId: 'planner:project', conversations: { projectRoot }, terminalToolNames: terminalTools }).disposition).toBe('ordinary_interruption');
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(count);
  });

  it('throws the exact pre-append signal reason and writes nothing', () => {
    const { projectRoot } = scenario();
    const controller = new AbortController();
    const reason = new Error('Stop won');
    controller.abort(reason);
    try { stabilize(projectRoot, controller.signal); throw new Error('expected Stop'); }
    catch (error) { expect(error).toBe(reason); }
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(2);
  });

  it('classifies only a reported reconstructed-result append error after the physical append', () => {
    const { projectRoot } = scenario();
    const publicationError = new Error('publication callback failed');
    const conversationChanged = jest.fn(() => { throw publicationError; });
    expect(() => stabilizeRoleSession({
      projectRoot,
      sessionId: 'planner:project',
      conversations: { projectRoot, changes: { conversationChanged, agentsChanged() {}, runtimeChanged() {}, cardProjectionChanged() {}, subscribe: () => ({ unsubscribe() {} }) } },
      terminalToolNames: terminalTools,
      reconstructedSettlement: { kind: 'reconstructed_barrier', childCardId: 'card-a', outcome: { status: 'cancelled', summary: 'cancelled' } },
      signal: new AbortController().signal,
    })).toThrow(ReconstructedActivationResultAppendError);
    expect(conversationChanged).toHaveBeenCalledTimes(1);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });
});

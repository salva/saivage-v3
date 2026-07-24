import { describe, expect, it } from '@jest/globals';

import {
  createCompactConversationValidationState,
  estimateCompactConversationValidationBytes,
  finishCompactConversationValidation,
  reduceCompactConversationRow,
  validateConversationPrefixRows,
} from '../../src/contracts/conversation-compact-reducer.js';
import { hashConversationRows } from '../../src/contracts/conversation-compaction.js';
import { serializeToolCallMessage } from '../../src/contracts/persisted-tool-call.js';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type ConversationSessionId } from '../../src/schemas/index.js';
import { foldCanonicalGrowingFileRows, type CanonicalGrowingFileReadIo } from '../../src/persistence/growing-file.js';
import { longCompactFoldFixture } from '../helpers/long-compact-fold-fixture.js';

describe('compact conversation validation reducer', () => {
  it('validates many rounds, repair segments, retained static ids, late hashes, and a final partial round by checkpoint replay', () => {
    const small = runFixture(8);
    const large = runFixture(20_000);
    expect(small.state.sources).toHaveLength(25);
    expect(small.state.rounds).toHaveLength(6);
    expect(small.state.rounds.every((round) => round.segments.map((segment) => segment.kind).join(',') === 'initial,repair')).toBe(true);
    expect(small.state.compactionCount).toBe(3);
    expect(small.state.retainedStaticIds).toEqual(['static']);
    expect(estimateCompactConversationValidationBytes(small.state)).toBe(estimateCompactConversationValidationBytes(large.state));
    expect(JSON.stringify(small.state)).not.toContain('source-1-');
    expect(JSON.stringify(large.state)).not.toContain('x'.repeat(100));
    expect(small.result.canonicalBytesRead + small.result.replayBytesRead).toBe(small.fixture.bytes.byteLength * 2 + small.state.replayBytesRead);
    expect(large.result.canonicalBytesRead + large.result.replayBytesRead).toBe(large.fixture.bytes.byteLength * 2 + large.state.replayBytesRead);
    expect(small.replaySpans.size).toBeGreaterThan(1);
    expect([...small.replaySpans].every((span) => small.sourceSpans.has(span))).toBe(true);
  });

  it('rejects reordered sources, wrong hashes, retained statics, segmentation, and unsafe partial boundaries', () => {
    const fixture = longCompactFoldFixture(4);
    const final = fixture.rows.at(-1)!;
    const mutate = (change: (payload: any) => void): AgentMessage => {
      const payload = JSON.parse(final.content);
      change(payload);
      return agentMessageSchema.parse({ ...final, content: JSON.stringify(sortJson(payload)) });
    };
    const prefix = fixture.rows.slice(0, -1);
    expect(() => validateConversationPrefixRows(fixture.sessionId, [...prefix, mutate((payload) => payload.summaries[0].rounds[0].segments[0].source_message_ids.reverse())])).toThrow();
    expect(() => validateConversationPrefixRows(fixture.sessionId, [...prefix, mutate((payload) => { payload.summaries[0].content_hash = '0'.repeat(64); })])).toThrow(/hash/);
    expect(() => validateConversationPrefixRows(fixture.sessionId, [...prefix, mutate((payload) => { payload.retained_static_message_ids = []; })])).toThrow(/static/);
    expect(() => validateConversationPrefixRows(fixture.sessionId, [...prefix, mutate((payload) => { payload.summaries[0].rounds[0].segments[0].kind = 'repair'; })])).toThrow(/segmentation/);
    expect(() => validateConversationPrefixRows(fixture.sessionId, [...prefix, mutate((payload) => {
      const last = payload.summaries.at(-1).rounds[0];
      last.segments[0].source_message_ids.push('round-6-text');
      payload.summaries.at(-1).content_hash = '0'.repeat(64);
    })])).toThrow();
  });

  it('shares bounded prefix identity, activation, tool-pair, duplicate, and preceding-compaction semantics', () => {
    const session: ConversationSessionId = 'agent:planner:global';
    const activation = row(session, 'activation', 'system', 'activity', JSON.stringify({ event: 'activation_open', agent_name: 'planner', input_id: '00000000-0000-4000-8000-000000000001', timestamp: TS }));
    const sourceInput = '11111111-1111-4111-8111-111111111111';
    const call = row(session, `${sourceInput}:tool-call:call-1`, 'assistant', 'tool_call', toolCallContent('call-1', 'read'), { tool: 'read', tool_call_id: 'call-1' });
    const result = row(session, `${sourceInput}:tool-result:call-1`, 'tool', 'tool_result', '{"success":true}', { tool: 'read', tool_call_id: 'call-1' });
    expect(() => validateConversationPrefixRows(session, [activation, call])).not.toThrow();
    expect(() => validateConversationPrefixRows(session, [activation, call, result])).not.toThrow();
    expect(() => validateConversationPrefixRows(session, [activation, result])).toThrow(/matching earlier call/);
    expect(() => validateConversationPrefixRows(session, [activation, call, row(session, 'later', 'user', 'text', 'later')])).toThrow(/non-final unmatched/);
    expect(() => validateConversationPrefixRows(session, [activation, { ...activation }])).toThrow(/duplicate/);
    expect(() => validateConversationPrefixRows(session, [{ ...activation, session_id: 'agent:reviewer:global' } as AgentMessage])).toThrow(/belongs to session/);
    expect(() => validateConversationPrefixRows(session, [{ ...activation, content: JSON.stringify({ event: 'activation_open', role: 'analyst', input_id: 'bad', timestamp: TS }) }])).toThrow(/malformed/);
    expect(() => validateConversationPrefixRows(session, [{ ...activation, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: TS }) }])).toThrow(/malformed/);

    const cardSession: ConversationSessionId = 'agent:planner:project';
    const cardActivation = row(cardSession, 'card-activation', 'system', 'activity', JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000002', timestamp: TS }));
    expect(() => validateConversationPrefixRows(cardSession, [cardActivation])).not.toThrow();
    expect(() => validateConversationPrefixRows(cardSession, [{ ...cardActivation, content: activation.content }])).toThrow(/malformed/);
  });

  it('pairs calls with later results by identity rather than source-row adjacency', () => {
    const session: ConversationSessionId = 'agent:planner:global';
    const activation = activationRow(session);
    const first = toolPair(session, '11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    const second = toolPair(session, '22222222-2222-4222-8222-222222222222', 'call-2', 'write');
    const unrelated = row(session, 'intervening-source', 'assistant', 'text', 'intervening source');

    expect(() => validateConversationPrefixRows(session, [activation, first.call, unrelated, first.result])).not.toThrow();
    expect(() => validateConversationPrefixRows(session, [activation, first.call, partialCompaction(session, 'between-call-result', [activation]), unrelated, first.result])).not.toThrow();
    expect(() => validateConversationPrefixRows(session, [activation, first.call, second.call, unrelated, second.result, first.result])).not.toThrow();
    expect(() => validateConversationPrefixRows(session, [activation, unrelated, first.call])).not.toThrow();

    expect(() => validateConversationPrefixRows(session, [activation, first.call, unrelated])).toThrow(/non-final unmatched/);
    expect(() => validateConversationPrefixRows(session, [activation, first.call, second.call])).toThrow(/more than one unmatched/);
    expect(() => validateConversationPrefixRows(session, [activation, first.result, first.call])).toThrow(/matching earlier call/);
    expect(() => validateConversationPrefixRows(session, [activation, first.call, first.call])).toThrow(/duplicate/);
    expect(() => validateConversationPrefixRows(session, [activation, first.call, first.result, first.result])).toThrow(/duplicate/);
    expect(() => validateConversationPrefixRows(session, [activation, first.call, { ...first.result, tool: 'other' }])).toThrow(/same identity and tool name/);
    expect(() => validateConversationPrefixRows(session, [activation, first.call, second.result])).toThrow(/matching earlier call/);
  });

  it('strictly validates generic durable tool payloads while keeping result data opaque', () => {
    const session: ConversationSessionId = 'agent:planner:global';
    const activation = activationRow(session);
    const pair = toolPair(session, '11111111-1111-4111-8111-111111111111', 'call-1', 'read_agent_session');

    expect(() => validateConversationPrefixRows(session, [activation, { ...pair.call, content: '{}' }])).toThrow(/malformed embedded content/);
    expect(() => validateConversationPrefixRows(session, [activation, { ...pair.call, content: toolCallContent('other-id', 'read_agent_session') }])).toThrow(/embedded identity/);
    expect(() => validateConversationPrefixRows(session, [activation, { ...pair.call, content: toolCallContent('call-1', 'other-tool') }])).toThrow(/embedded identity/);
    expect(() => validateConversationPrefixRows(session, [activation, { ...pair.call, role: 'user' }])).toThrow(/assistant role/);
    expect(() => validateConversationPrefixRows(session, [activation, pair.call, { ...pair.result, role: 'assistant' }])).toThrow(/tool role/);
    expect(() => validateConversationPrefixRows(session, [activation, pair.call, { ...pair.result, content: '{"success":true,"unexpected":1}' }])).toThrow(/malformed content/);
    expect(() => validateConversationPrefixRows(session, [activation, pair.call, { ...pair.result, content: '{"success":false}' }])).toThrow(/malformed content/);

    const oldAnalystData = { success: true, data: [{ session_id: 'legacy', messages: [{ arbitrary: ['opaque'] }] }] };
    expect(() => validateConversationPrefixRows(session, [activation, pair.call, { ...pair.result, content: JSON.stringify(oldAnalystData) }])).not.toThrow();
    const bounded = toolPair(session, '22222222-2222-4222-8222-222222222222', 'call-2', 'read_agent_session');
    const oldBoundedData = { success: true, data: { session: { id: 'legacy' }, total_messages: 9, returned: 1, parse_errors: 0, messages: [{ arbitrary: { nested: true } }] } };
    expect(() => validateConversationPrefixRows(session, [activation, pair.call, { ...pair.result, content: JSON.stringify(oldAnalystData) }, bounded.call, { ...bounded.result, content: JSON.stringify(oldBoundedData) }])).not.toThrow();
  });

  it('derives failed-result repair segmentation from the parsed generic result envelope', () => {
    const session: ConversationSessionId = 'agent:planner:global';
    const activation = activationRow(session);
    const pair = toolPair(session, '11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    const failed = { ...pair.result, content: '{"success":false,"error":"failed","data":{"legacy":"opaque"}}' };
    const after = row(session, 'after-failure', 'assistant', 'text', 'repair continuation');
    const rows = [activation, pair.call, failed, after];
    const state = createCompactConversationValidationState(session);
    const replayRows = (checkpoints: readonly { rowOrdinal: number }[]) => checkpoints.map((checkpoint) => rows[checkpoint.rowOrdinal]!);
    const replay = { replayRow: (checkpoint: { rowOrdinal: number }) => replayRows([checkpoint])[0]!, replayRows };
    rows.forEach((message, rowOrdinal) => reduceCompactConversationRow(state, message, { lineStart: 0, lineEnd: 1, rowOrdinal }, replay));
    finishCompactConversationValidation(state);

    expect(state.sources[2]).toEqual(expect.objectContaining({ failedToolResult: true, repairAnchor: true }));
    expect(state.rounds[0]!.segments).toEqual([
      { kind: 'initial', start: 0, end: 2 },
      { kind: 'repair', start: 2, end: 4 },
    ]);
  });

  it('rejects partial compaction inside tool and provider bundles', () => {
    const session: ConversationSessionId = 'agent:planner:global';
    const activation = row(session, 'activation', 'system', 'activity', JSON.stringify({ event: 'activation_open', agent_name: 'planner', input_id: '00000000-0000-4000-8000-000000000001', timestamp: TS }));
    const sourceInput = '11111111-1111-4111-8111-111111111111';
    const call = row(session, `${sourceInput}:tool-call:call-1`, 'assistant', 'tool_call', toolCallContent('call-1', 'read'), { tool: 'read', tool_call_id: 'call-1' });
    const result = row(session, `${sourceInput}:tool-result:call-1`, 'tool', 'tool_result', '{"success":true}', { tool: 'read', tool_call_id: 'call-1' });
    expect(() => validateConversationPrefixRows(session, [activation, call, result, partialCompaction(session, 'tool-cut', [activation, call])])).toThrow(/bundle/);

    const privateRow = row(session, 'private', 'system', 'provider_private', '{}');
    const visible = row(session, 'visible', 'assistant', 'text', 'visible', { provider_projection: { kind: 'openai_responses', source_input_id: sourceInput, private_message_id: 'private', projection_kind: 'assistant_message' } });
    expect(() => validateConversationPrefixRows(session, [activation, privateRow, visible, partialCompaction(session, 'provider-cut', [activation, privateRow])])).toThrow(/bundle/);
  });
});

function runFixture(contentBytes: number) {
  const fixture = longCompactFoldFixture(contentBytes);
  const io = memoryIo(fixture.bytes);
  const state = createCompactConversationValidationState(fixture.sessionId);
  const replaySpans = new Set<string>();
  const sourceSpans = new Set<string>();
  const result = foldCanonicalGrowingFileRows({
    path: '/conversation.jsonl', rowSchema: agentMessageSchema, logicalId: (row) => row.id, initialState: state, io: io.io, chunkBytes: 97,
    instrumentation: { onReadChunk(position, bytes, phase) { if (phase === 'replay') replaySpans.add(`${position}:${position + bytes}`); } },
    reduce(current, row, checkpoint, replay) { if (row.kind !== 'context_compaction') sourceSpans.add(`${checkpoint.lineStart}:${checkpoint.lineEnd}`); return reduceCompactConversationRow(current, row, checkpoint, replay); },
  });
  finishCompactConversationValidation(result.state);
  expect(result.replayBytesRead).toBe(result.state.replayBytesRead);
  return { fixture, state: result.state, result, replaySpans, sourceSpans };
}

function memoryIo(content: Buffer): { io: CanonicalGrowingFileReadIo } {
  return { io: {
    open() { return 1; }, stat() { return { isFile: () => true } as never; },
    read(_fd, buffer, offset, length, position) { return content.copy(buffer, offset, position, Math.min(content.byteLength, position + length)); },
    truncate() { throw new Error('unexpected truncate'); }, fsync() { throw new Error('unexpected fsync'); }, close() {},
  } };
}

const TS = '2026-07-24T00:00:00.000Z';
function activationRow(sessionId: ConversationSessionId): AgentMessage {
  return row(sessionId, 'activation', 'system', 'activity', JSON.stringify({ event: 'activation_open', agent_name: 'planner', input_id: '00000000-0000-4000-8000-000000000001', timestamp: TS }));
}

function toolPair(sessionId: ConversationSessionId, sourceInputId: string, callId: string, tool: string): { call: AgentMessage; result: AgentMessage } {
  return {
    call: row(sessionId, `${sourceInputId}:tool-call:${callId}`, 'assistant', 'tool_call', toolCallContent(callId, tool), { tool, tool_call_id: callId }),
    result: row(sessionId, `${sourceInputId}:tool-result:${callId}`, 'tool', 'tool_result', '{"success":true}', { tool, tool_call_id: callId }),
  };
}

function toolCallContent(callId: string, tool: string): string {
  return JSON.stringify(serializeToolCallMessage({ id: callId, name: tool, args: {} }));
}

function row(sessionId: ConversationSessionId, id: string, role: AgentMessage['role'], kind: AgentMessage['kind'], content: string, extra: Partial<AgentMessage> = {}): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: sessionId, role, kind, content, round_id: `r-user-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp: TS, ...extra });
}

function partialCompaction(sessionId: ConversationSessionId, id: string, covered: AgentMessage[]): AgentMessage {
  const payload = contextCompactionContentSchema.parse({
    boundary: 'message', retained_static_message_ids: [],
    summaries: [{ kind: 'individual', rounds: [{ complete: false, segments: [{ kind: 'initial', source_message_ids: covered.map((source) => source.id) }] }], content_hash: hashConversationRows(covered), summary_text: 'partial', evidence: [] }],
    applied_policy: { mode: 'hard_limit_fallback', band: 'normal', input_budget_tokens: 1000, canonical_estimated_static_tokens: 0, trigger_fraction: 0.8, completion_reserve_fraction: 0.2, merge_line_fraction: 0.3, summary_line_fraction: 0.5, snap: 'compact_straddler' },
  });
  return row(sessionId, id, 'system', 'context_compaction', canonicalJson(payload));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, sortJson(child)]));
  return value;
}

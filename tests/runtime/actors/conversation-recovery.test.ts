import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { agentMessageSchema, canonicalJson, contextCompactionContentSchema, type AgentMessage, type MessageKind, type MessageRole, type ConversationSessionId } from '../../../src/schemas/index.js';
import { classifyConversation, stabilizeRoleSession } from '../../../src/runtime/actors/conversation-recovery.js';

import { hashConversationRows, validateConversationRows } from '../../../src/contracts/conversation-compaction.js';
import { appendConversationBatch, readConversation } from '../../../src/persistence/conversation-file.js';
import { conversationFile } from '../../../src/runtime/actors/conversation-inventory.js';
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

  it('treats a failed terminal tool_result as an unfinished corrective continuation', () => {
    const result = toolResult('planner:G-1:1', 'call-1', 'planner:project', 'emit_result', { success: false, error: 'tool failed' });
    expect(classifyConversation([toolCall('planner:G-1:1', 'call-1'), result], terminalTools)).toBe('pending_provider');
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

describe('exact role-session stabilization', () => {
  const roots: string[] = [];
  afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

  function scenario(role: 'planner' | 'reviewer' | 'executor' = 'planner', cardId = 'project') {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-role-stabilization-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    const sessionId = `${role}:${cardId}` as ConversationSessionId;
    const sourceInputId = '11111111-1111-4111-8111-111111111111';
    appendConversationBatch({ projectRoot }, [
      message({ id: `${sessionId}:activation:one`, session_id: sessionId, kind: 'activity', content: JSON.stringify({ event: 'activation_open', role, card_id: cardId, input_id: sourceInputId, timestamp: '2026-07-08T00:00:00.000Z' }) }),
    ]);
    return { projectRoot, sessionId, sourceInputId };
  }

  function stabilize(projectRoot: string, sessionId: ConversationSessionId = 'planner:project') {
    return stabilizeRoleSession({ projectRoot, sessionId, conversations: { projectRoot }, terminalToolNames: terminalTools });
  }

  it('treats ENOENT as an empty session only for the initial stabilization read', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-role-stabilization-empty-'));
    roots.push(projectRoot);
    initProjectTree(projectRoot);
    expect(stabilize(projectRoot)).toEqual({ disposition: 'clean', messages: [] });
    expect(() => readConversation(projectRoot, 'planner:project')).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it('keeps the required final recovery read strict when the canonical file disappears', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [message({ id: `${sourceInputId}:pending`, session_id: sessionId, kind: 'text', role: 'assistant', content: 'pending' })]);
    const path = conversationFile(projectRoot, sessionId);
    let failure: unknown;
    try {
      stabilizeRoleSession({
        projectRoot,
        sessionId,
        conversations: { projectRoot, changes: { conversationChanged() { rmSync(path); }, agentsChanged() {} } },
        terminalToolNames: terminalTools,
      });
    } catch (error) { failure = error; }
    expect((failure as NodeJS.ErrnoException).code).toBe('ENOENT');
  });

  it.each(['planner', 'reviewer', 'executor'] as const)('stabilizes an interrupted %s corrective continuation', (role) => {
    const cardId = 'project';
    const { projectRoot, sessionId, sourceInputId } = scenario(role, cardId);
    appendConversationBatch({ projectRoot }, [toolCall(sourceInputId, 'emit', sessionId), toolResult(sourceInputId, 'emit', sessionId, 'emit_result', { success: false, data: { reason: 'pending_notifications' } })]);
    expect(stabilize(projectRoot, sessionId).disposition).toBe('ordinary_interruption');
    const rows = readConversation(projectRoot, sessionId).sourceRows;
    expect(rows.at(-1)).toMatchObject({ id: `${sourceInputId}:model-recovered`, session_id: sessionId, kind: 'model_recovered', round_id: `r-pre-${createHash('sha256').update(sourceInputId).digest('hex').slice(0, 32)}` });
  });

  it('settles an unmatched activate_card as ordinary outcome-unknown without child reconstruction', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [toolCall(sourceInputId, 'activate-child', sessionId, 'activate_card')]);
    stabilize(projectRoot, sessionId);
    const rows = readConversation(projectRoot, sessionId).sourceRows;
    expect(JSON.parse(rows.at(-2)!.content)).toEqual({ success: false, error: 'Runtime activation was interrupted before completion. External or domain effects may or may not have happened.', data: { outcome_unknown: true } });
    expect(rows.at(-1)?.id).toBe(`${sourceInputId}:model-recovered`);
  });

  it.each<[string, 'model_repair' | 'text', 'user' | 'assistant']>([['provider', 'model_repair', 'user'], ['text', 'text', 'assistant']])('appends only the marker-bound notice for %s pending work', (_name, kind, role) => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [message({ id: `${sourceInputId}:${kind}`, session_id: sessionId, kind, role, content: 'pending' })]);
    stabilize(projectRoot, sessionId);
    const rows = readConversation(projectRoot, sessionId).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result')).toHaveLength(0);
    expect(rows.at(-1)?.id).toBe(`${sourceInputId}:model-recovered`);
  });

  it('rejects multiple unmatched calls without appending any settlement', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [message({
      id: `${sourceInputId}:tool-call:call-1`, session_id: sessionId, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-1',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }), message_index: 1,
    }), message({
      id: `${sourceInputId}:tool-call:call-2`, session_id: sessionId, role: 'assistant', kind: 'tool_call', tool: 'read', tool_call_id: 'call-2',
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-2', type: 'function', function: { name: 'read', arguments: '{}' } }] }), message_index: 2,
    })]);
    expect(() => stabilize(projectRoot, sessionId)).toThrow(/more than one unmatched tool call/);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });

  it('recognizes only the exact final marker-bound recovery notice and repeats read-only', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [message({ id: `${sourceInputId}:message`, session_id: sessionId, kind: 'text', role: 'assistant', content: 'pending' })]);
    stabilize(projectRoot, sessionId);
    const count = readConversation(projectRoot, 'planner:project').physicalRows.length;
    expect(stabilize(projectRoot, sessionId).disposition).toBe('clean');
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(count);
  });

  it('rejects a malformed recovery notice and newer work after an exact notice', () => {
    const malformed = scenario();
    appendConversationBatch({ projectRoot: malformed.projectRoot }, [message({ id: `${malformed.sourceInputId}:wrong-recovery`, session_id: malformed.sessionId, kind: 'model_recovered', role: 'system', content: 'wrong recovery body', block_index: 1 })]);
    expect(() => stabilize(malformed.projectRoot, malformed.sessionId)).toThrow(/not its final exact canonical source row/);

    const newer = scenario();
    appendConversationBatch({ projectRoot: newer.projectRoot }, [message({ id: `${newer.sourceInputId}:message`, session_id: newer.sessionId, kind: 'text', role: 'assistant', content: 'pending' })]);
    stabilize(newer.projectRoot, newer.sessionId);
    appendConversationBatch({ projectRoot: newer.projectRoot }, [message({ id: `${newer.sourceInputId}:newer-message`, session_id: newer.sessionId, kind: 'text', role: 'assistant', content: 'newer pending work' })]);
    expect(() => stabilize(newer.projectRoot, newer.sessionId)).toThrow(/not its final exact canonical source row/);
  });

  it('rejects missing and mismatched latest activation-marker association before recovery writes', () => {
    const missingRoot = mkdtempSync(join(tmpdir(), 'saivage-role-stabilization-missing-marker-')); roots.push(missingRoot); initProjectTree(missingRoot);
    appendConversationBatch({ projectRoot: missingRoot }, [message({ session_id: 'planner:project', kind: 'text', role: 'assistant', content: 'pending without marker' })]);
    expect(() => stabilize(missingRoot)).toThrow(/no activation marker/);
    expect(readConversation(missingRoot, 'planner:project').sourceRows).toHaveLength(1);

    const mismatched = scenario();
    appendConversationBatch({ projectRoot: mismatched.projectRoot }, [message({ id: `${mismatched.sourceInputId}:pending`, session_id: mismatched.sessionId, kind: 'text', role: 'assistant', content: 'pending' })]);
    const path = conversationFile(mismatched.projectRoot, mismatched.sessionId);
    const canonical = readFileSync(path, 'utf8');
    writeFileSync(path, canonical.replace('\\"role\\":\\"planner\\"', '\\"role\\":\\"reviewer\\"'));
    expect(() => stabilize(mismatched.projectRoot, mismatched.sessionId)).toThrow(/malformed planner activation_open marker/);
    expect(readFileSync(path, 'utf8')).not.toContain('model-recovered');
  });

  it('stops immediately when notice publication reports an error', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [message({ id: `${sourceInputId}:message`, session_id: sessionId, kind: 'text', role: 'assistant' })]);
    const publicationError = new Error('publication callback failed');
    const conversationChanged = jest.fn(() => { throw publicationError; });
    expect(() => stabilizeRoleSession({
      projectRoot,
      sessionId,
      conversations: { projectRoot, changes: { conversationChanged, agentsChanged() {} } },
      terminalToolNames: terminalTools,
    })).toThrow(publicationError);
    expect(conversationChanged).toHaveBeenCalledTimes(1);
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toHaveLength(3);
  });

  it('performs no notice append after failed-tool-result publication reports an error', () => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [toolCall(sourceInputId, 'pending', sessionId, 'activate_card')]);
    const publicationError = new Error('result publication callback failed');
    expect(() => stabilizeRoleSession({ projectRoot, sessionId, conversations: { projectRoot, changes: { conversationChanged() { throw publicationError; }, agentsChanged() {} } }, terminalToolNames: terminalTools })).toThrow(publicationError);
    const rows = readConversation(projectRoot, sessionId).sourceRows;
    expect(rows.filter((row) => row.kind === 'tool_result')).toHaveLength(1);
    expect(rows.filter((row) => row.kind === 'model_recovered')).toHaveLength(0);
  });

  it.each([
    { point: 'failed-result', toolPending: true }, { point: 'notice', toolPending: false },
  ] as const)('propagates a physical $point append failure with no later recovery row', ({ toolPending }) => {
    const { projectRoot, sessionId, sourceInputId } = scenario();
    appendConversationBatch({ projectRoot }, [toolPending ? toolCall(sourceInputId, 'pending', sessionId, 'activate_card') : message({ id: `${sourceInputId}:pending`, session_id: sessionId, kind: 'text', role: 'assistant', content: 'pending' })]);
    const path = conversationFile(projectRoot, sessionId);
    const before = readFileSync(path, 'utf8');
    const originalMode = statSync(path).mode;
    chmodSync(path, 0o444);
    try { expect(() => stabilize(projectRoot, sessionId)).toThrow(); }
    finally { chmodSync(path, originalMode); }
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});

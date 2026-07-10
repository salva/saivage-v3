import { describe, expect, it } from '@jest/globals';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendActivationMarker, appendConversationMessage, appendUserContextMessage, conversationDir, conversationMessagesForModel, listConversationSessionIds, readActiveVersionMessages, readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';
import { activeVersionPath, conversationIndexPath, writeConversationIndex } from '../../../src/runtime/actors/conversation-index.js';
import { codexMessages } from '../../../src/agents/llm-openai-codex-gateway.js';
import { buildOpenAIChatRequest } from '../../../src/agents/llm-openai-chat-gateway.js';
import type { AgentMessage } from '../../../src/schemas/index.js';

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    id: 'message-1',
    session_id: 'analyst:global',
    role: 'user',
    kind: 'text',
    content: 'launch the project',
    round_id: 'r-user-00000000000000000000000000000001',
    message_index: 1,
    block_index: 0,
    timestamp: '2026-07-05T21:12:29.842Z',
    ...overrides,
  };
}

describe('conversation-store', () => {
  it('rejects v1 conversation indexes instead of migrating them', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    const dir = conversationDir(root, 'analyst:global');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema_version: 1, active_segment: 'seg-001.jsonl' }) + '\n');
    writeFileSync(join(dir, 'seg-001.jsonl'), [
      JSON.stringify(makeMessage()),
      JSON.stringify(makeMessage()),
      JSON.stringify(makeMessage({ id: 'message-2', content: 'second request', message_index: 2 })),
    ].join('\n') + '\n');

    expect(() => readConversationMessages(root, 'analyst:global')).toThrow(/schema_version/);
    expect(existsSync(join(dir, 'seg-001.jsonl'))).toBe(true);
  });

  it('canonical transcript reads only active version rows and removes orphan version files on load', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    const sessionId = 'planner:project';
    const dir = conversationDir(root, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.jsonl'), [
      JSON.stringify(makeMessage({ id: 'frozen-1', session_id: sessionId, content: 'frozen one' })),
      JSON.stringify(makeMessage({ id: 'shared', session_id: sessionId, content: 'dedupe from frozen' })),
    ].join('\n') + '\n');
    writeFileSync(join(dir, '2.jsonl'), [
      JSON.stringify(makeMessage({ id: 'shared', session_id: sessionId, content: 'dedupe from active' })),
      JSON.stringify(makeMessage({ id: 'active-1', session_id: sessionId, content: 'active one' })),
    ].join('\n') + '\n');
    writeFileSync(join(dir, '3.jsonl'), JSON.stringify(makeMessage({ id: 'orphan', session_id: sessionId })) + '\n');
    writeConversationIndex(root, sessionId, {
      schema_version: 2,
      session_id: sessionId,
      active_version: 2,
      versions: {
        '1': { status: 'frozen', opened_at: '2026-07-05T21:12:29.842Z', frozen_at: '2026-07-05T21:12:30.842Z' },
        '2': { status: 'active', opened_at: '2026-07-05T21:12:31.842Z' },
      },
    });

    const active = readActiveVersionMessages(root, sessionId);
    const all = readConversationMessages(root, sessionId);

    expect(active.map((message) => message.id)).toEqual(['shared', 'active-1']);
    expect(all.map((message) => message.id)).toEqual(['shared', 'active-1']);
    expect(all.find((message) => message.id === 'shared')?.content).toBe('dedupe from active');
    expect(existsSync(join(dir, '3.jsonl'))).toBe(false);
  });

  it('persists identical user context content with unique ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));

    const first = appendUserContextMessage(root, 'planner:project', 'input-1', 'notification', 0, { role: 'user', content: 'same content' });
    const second = appendUserContextMessage(root, 'planner:project', 'input-1', 'notification', 1, { role: 'user', content: 'same content' });
    const messages = readConversationMessages(root, 'planner:project');

    expect(first.message.id).not.toBe(second.message.id);
    expect(messages.filter((message) => message.content === 'same content')).toHaveLength(2);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it('reports append results and idempotent tail duplicates', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    const message = makeMessage({ id: 'same-id', session_id: 'analyst:global' });

    expect(appendConversationMessage(root, message)).toMatchObject({ message, appended: true });
    expect(appendConversationMessage(root, message)).toMatchObject({ message, appended: false });
    expect(readConversationMessages(root, 'analyst:global').map((row) => row.id)).toEqual(['same-id']);
  });

  it('keeps activation markers out of provider context while active-version read returns the persisted prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));

    appendUserContextMessage(root, 'planner:project', 'input-1', 'planner_state', 0, { role: 'user', content: 'planner state' });
    appendActivationMarker(root, 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: 'input-1' });

    const active = readActiveVersionMessages(root, 'planner:project');
    expect(active.map((message) => message.kind)).toEqual(['text', 'activity']);
    expect(conversationMessagesForModel(active).map((message) => message.content)).toEqual(['planner state']);
  });

  it('appends only to the active version', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    const sessionId = 'planner:project';
    const dir = conversationDir(root, sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '1.jsonl'), JSON.stringify(makeMessage({ id: 'frozen', session_id: sessionId })) + '\n');
    writeFileSync(join(dir, '2.jsonl'), '');
    writeConversationIndex(root, sessionId, {
      schema_version: 2,
      session_id: sessionId,
      active_version: 2,
      versions: {
        '1': { status: 'frozen', opened_at: '2026-07-05T21:12:29.842Z', frozen_at: '2026-07-05T21:12:30.842Z' },
        '2': { status: 'active', opened_at: '2026-07-05T21:12:31.842Z' },
      },
    });

    appendConversationMessage(root, makeMessage({ id: 'new-active', session_id: sessionId, content: 'new active row' }));

    expect(readFileSync(join(dir, '1.jsonl'), 'utf-8')).not.toContain('new-active');
    expect(readFileSync(join(dir, '2.jsonl'), 'utf-8')).toContain('new-active');
  });

  it('includes context compaction rows in provider-visible messages', () => {
    const row = makeMessage({
      id: 'summary-1',
      role: 'user',
      kind: 'context_compaction',
      round_id: 'r-compacted-00000000000000000000000000000001',
      content: '[Compacted prior conversation — generation 1]: summary',
    });

    expect(conversationMessagesForModel([makeMessage({ kind: 'activity', content: '{}' }), row]).map((message) => message.id)).toEqual(['summary-1']);
  });

  it('serializes user-role context compaction rows for provider payloads', () => {
    const row = makeMessage({
      id: 'summary-1',
      role: 'user',
      kind: 'context_compaction',
      round_id: 'r-compacted-00000000000000000000000000000001',
      content: '[Compacted prior conversation — generation 1]: summary',
    });

    const codex = codexMessages([row]);
    expect(codex.filter((message) => 'role' in message && message.role === 'user')).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: row.content }] },
    ]);

    const chat = buildOpenAIChatRequest(
      { provider: 'openai-chat', account: null, model: 'test-model' },
      'system prompt',
      [row],
      { inputId: 'test:input:1', phase: 'tools', tools: [], tool_choice: { kind: 'auto' }, contract_id: 'test', contractName: 'test', terminalToolOffered: [] },
    );
    expect(chat.messages.filter((message) => message.role === 'user')).toEqual([{ role: 'user', content: row.content }]);
  });

  it('exports versioned paths for active version files', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    expect(activeVersionPath(root, 'planner:project', 12)).toMatch(/12\.jsonl$/);
    expect(conversationIndexPath(root, 'planner:project')).toMatch(/index\.json$/);
  });

  it('routes card conversations under the owning card and analyst conversations under agents', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));

    expect(conversationDir(root, 'planner:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'conversations', 'planner%3Acard-7'));
    expect(conversationDir(root, 'executor:card-7')).toBe(join(root, '.saivage', 'cards', 'card-7', 'conversations', 'executor%3Acard-7'));
    expect(conversationDir(root, 'reviewer:card-7:assessment-1')).toBe(join(root, '.saivage', 'cards', 'card-7', 'conversations', 'reviewer%3Acard-7%3Aassessment-1'));
    expect(conversationDir(root, 'analyst:global')).toBe(join(root, '.saivage', 'agents', 'conversations', 'analyst%3Aglobal'));
  });

  it('lists analyst and card-owned conversation sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    appendConversationMessage(root, makeMessage({ id: 'analyst-msg', session_id: 'analyst:global' }));
    appendConversationMessage(root, makeMessage({ id: 'planner-msg', session_id: 'planner:card-7' }));
    appendConversationMessage(root, makeMessage({ id: 'reviewer-msg', session_id: 'reviewer:card-7:assessment-1' }));

    expect(listConversationSessionIds(root)).toEqual(['analyst:global', 'planner:card-7', 'reviewer:card-7:assessment-1']);
    expect(readConversationMessages(root, 'planner:card-7').map((message) => message.id)).toEqual(['planner-msg']);
  });
});

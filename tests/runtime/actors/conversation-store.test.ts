import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendActivationMarker, appendUserContextMessage, conversationMessagesForModel, readActiveVersionMessages, readConversationMessages } from '../../../src/runtime/actors/conversation-store.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
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
  it('deduplicates repeated message ids when reading conversation segments', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));
    const dir = join(root, '.saivage', 'agents', 'conversations', encodeURIComponent('analyst:global'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ schema_version: 1, active_segment: 'seg-001.jsonl' }) + '\n');
    writeFileSync(join(dir, 'seg-001.jsonl'), [
      JSON.stringify(makeMessage()),
      JSON.stringify(makeMessage()),
      JSON.stringify(makeMessage({ id: 'message-2', content: 'second request', message_index: 2 })),
    ].join('\n') + '\n');

    const messages = readConversationMessages(root, 'analyst:global');

    expect(messages.map((message) => message.id)).toEqual(['message-1', 'message-2']);
    expect(messages.filter((message) => message.content === 'launch the project')).toHaveLength(1);
  });

  it('persists identical user context content with unique ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));

    const first = appendUserContextMessage(root, 'planner:project', 'input-1', 'notification', 0, 'same content');
    const second = appendUserContextMessage(root, 'planner:project', 'input-1', 'notification', 1, 'same content');
    const messages = readConversationMessages(root, 'planner:project');

    expect(first.id).not.toBe(second.id);
    expect(messages.filter((message) => message.content === 'same content')).toHaveLength(2);
    expect(new Set(messages.map((message) => message.id)).size).toBe(2);
  });

  it('keeps activation markers out of provider context while active-version read returns the persisted prefix', () => {
    const root = mkdtempSync(join(tmpdir(), 'saivage-conversation-store-'));

    appendUserContextMessage(root, 'planner:project', 'input-1', 'planner_state', 0, 'planner state');
    appendActivationMarker(root, 'planner:project', { event: 'activation_open', role: 'planner', card_id: 'project', input_id: 'input-1' });

    const active = readActiveVersionMessages(root, 'planner:project');
    expect(active.map((message) => message.kind)).toEqual(['text', 'activity']);
    expect(conversationMessagesForModel(active).map((message) => message.content)).toEqual(['planner state']);
  });
});

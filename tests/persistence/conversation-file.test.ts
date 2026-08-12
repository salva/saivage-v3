import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { appendConversationBatch, readConversation, readConversationCatalog, readCurrentConversationSegment, recoverCurrentConversationHead } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile } from '../../src/persistence/layout.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('versioned conversation persistence', () => {
  it('retains a configured empty index and publishes ordinary v1 before membership', () => {
    const projectRoot = root(); const effects: unknown[] = [];
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBeNull();
    expect(readConversation(projectRoot, SESSION).physicalRows).toEqual([]);
    appendConversationBatch({ projectRoot, changes: { conversationChanged: (target) => { effects.push(target); }, agentMembershipChanged: (target) => { effects.push(target); } } }, [text('first')]);
    expect(effects).toEqual([{ session_id: SESSION, segment_version: 1, visible_message_id: 'first' }, { scope: 'card', cardId: 'project' }]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    expect(segment.genesis.kind).toBe('ordinary_segment_genesis');
    expect(segment.rows.map((row) => row.id)).toEqual(['first']);
    expect(readConversationCatalog(projectRoot, SESSION).versions).toHaveLength(1);
  });

  it('appends one conversation-segment envelope and emits the resulting visible tip', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const effects: unknown[] = [];
    appendConversationBatch({ projectRoot, changes: { conversationChanged: (target) => { effects.push(target); }, agentMembershipChanged() {} } }, [privateRow('private'), projectedText('second', 'private')]);
    expect(effects).toEqual([{ session_id: SESSION, segment_version: 1, visible_message_id: 'second' }]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!; const lines = segment.bytes.toString('utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['conversation-segment', 'conversation-segment']);
    expect(lines[0].rows[0].kind).toBe('ordinary_segment_genesis');
    expect(lines[1].rows.map((row: AgentMessage) => row.id)).toEqual(['private', 'second']);
  });

  it('keeps runtime reads correction-free when the current segment has an unterminated suffix', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); const canonical = readFileSync(path); appendFileSync(path, '{"unterminated":');
    expect(() => readConversation(projectRoot, SESSION)).toThrow(/incomplete final envelope/);
    expect(readFileSync(path)).toEqual(Buffer.concat([canonical, Buffer.from('{"unterminated":')]));
  });

  it('lets initialization truncate a complete malformed suffix to the maximum valid checkpoint', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); const canonical = readFileSync(path); appendFileSync(path, '{"complete":"malformed"}\n');
    expect(() => readConversation(projectRoot, SESSION)).toThrow(/malformed/);
    recoverCurrentConversationHead(projectRoot, SESSION);
    expect(readFileSync(path)).toEqual(canonical);
    expect(readConversation(projectRoot, SESSION).sourceRows.map((row) => row.id)).toEqual(['first']);
  });

  it('drops only an unrecoverable sole head and leaves the configured index empty', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename);
    const bytes = readFileSync(path); bytes[0] = 0x78; // destroy the first envelope while retaining a complete physical line
    writeFileSync(path, bytes);
    recoverCurrentConversationHead(projectRoot, SESSION);
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBeNull();
  });

  it('rejects an invalid append before publication', () => {
    const projectRoot = root(); const one = text('same'); const two = { ...text('other'), id: 'same' };
    expect(() => appendConversationBatch({ projectRoot }, [one, two])).toThrow(/duplicate message ids/);
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBeNull();
  });
});

const SESSION = 'agent:planner:project' as const;
function root(): string { const value = mkdtempSync(join(tmpdir(), 'saivage-conversation-file-')); roots.push(value); initProjectTree(value); return value; }
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', content: id, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }
function projectedText(id: string, privateId: string): AgentMessage { return agentMessageSchema.parse({ ...text(id), role: 'assistant', round_id: `r-assistant-${'0'.repeat(32)}`, provider_projection: { kind: 'openai_responses', source_input_id: '00000000-0000-4000-8000-000000000001', private_message_id: privateId, projection_kind: 'assistant_message' } }); }
function privateRow(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: '00000000-0000-4000-8000-000000000001', projection_message_id: 'second', provider: 'openai', model: 'test', output: [] }), round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }

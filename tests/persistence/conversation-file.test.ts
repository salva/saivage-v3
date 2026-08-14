import { appendFileSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { appendConversationBatch, readConversation, readConversationCatalog, readCurrentConversationSegment, truncateCurrentConversationUnterminatedSuffix } from '../../src/persistence/conversation-file.js';
import { cardConversationVersionFile, cardConversationVersionIndexFile } from '../../src/persistence/layout.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';

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

  it('truncates only an unterminated suffix after validating the complete prefix', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); const canonical = readFileSync(path); appendFileSync(path, '{"unterminated":');
    truncateCurrentConversationUnterminatedSuffix(projectRoot, SESSION);
    expect(readFileSync(path)).toEqual(canonical);
    expect(readConversation(projectRoot, SESSION).sourceRows.map((row) => row.id)).toEqual(['first']);
  });

  it.each(['complete-malformed', 'semantic-invalid', 'no-complete-prefix', 'missing-segment', 'genesis-mismatch', 'index-mismatch'] as const)('rejects %s current authority without changing indexed bytes', (fault) => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename);
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    if (fault === 'complete-malformed') appendFileSync(path, '{"complete":"malformed"}\n');
    else if (fault === 'semantic-invalid') appendFileSync(path, `${JSON.stringify({ version: 1, type: 'conversation-segment', rows: [text('first')] })}\n`);
    else if (fault === 'no-complete-prefix') writeFileSync(path, '{"unterminated":');
    else if (fault === 'missing-segment') unlinkSync(path);
    else if (fault === 'genesis-mismatch') {
      const lines = readFileSync(path, 'utf8').trimEnd().split('\n'); const envelope = JSON.parse(lines[0]!) as { rows: Array<{ entry_id: string }> };
      envelope.rows[0]!.entry_id = '00000000-0000-4000-8000-000000000001'; lines[0] = JSON.stringify(envelope); writeFileSync(path, `${lines.join('\n')}\n`);
    }
    else {
      const index = JSON.parse(readFileSync(indexPath, 'utf8')) as { session_id: string };
      writeFileSync(indexPath, `${JSON.stringify({ ...index, session_id: 'agent:executor:project' })}\n`);
    }
    const beforeIndex = readFileSync(indexPath); const beforeSegment = fault === 'missing-segment' ? null : readFileSync(path);
    expect(() => truncateCurrentConversationUnterminatedSuffix(projectRoot, SESSION)).toThrow();
    expect(readFileSync(indexPath)).toEqual(beforeIndex);
    if (beforeSegment) expect(readFileSync(path)).toEqual(beforeSegment);
  });

  it('uses exactly open, ftruncate, fsync, close on successful truncation and does not reread', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); appendFileSync(path, 'suffix');
    const trace: string[] = [];
    const result = truncateCurrentConversationUnterminatedSuffix(projectRoot, SESSION, {
      open() { trace.push('open'); return 7; }, ftruncate() { trace.push('ftruncate'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    });
    expect(trace).toEqual(['open', 'ftruncate', 'fsync', 'close']);
    expect(result?.rows.map((row) => row.id)).toEqual(['first']);
  });

  it('keeps open failure direct and makes each post-truncation failure outcome-unknown and final', () => {
    const direct = new Error('open failed');
    const openFixture = truncationFixture();
    expect(() => truncateCurrentConversationUnterminatedSuffix(openFixture, SESSION, { open() { throw direct; }, ftruncate() {}, fsync() {}, close() {} })).toThrow(direct);
    for (const failed of ['ftruncate', 'fsync', 'close'] as const) {
      const projectRoot = truncationFixture(); const trace: string[] = [];
      const operation = (name: string): void => { trace.push(name); if (name === failed) throw new Error('injected'); };
      expect(() => truncateCurrentConversationUnterminatedSuffix(projectRoot, SESSION, {
        open() { trace.push('open'); return 7; }, ftruncate() { operation('ftruncate'); }, fsync() { operation('fsync'); }, close() { operation('close'); },
      })).toThrow(PublicationOutcomeUnknownError);
      expect(trace.at(-1)).toBe(failed);
    }
  });

  it('rejects an invalid append before publication', () => {
    const projectRoot = root(); const one = text('same'); const two = { ...text('other'), id: 'same' };
    expect(() => appendConversationBatch({ projectRoot }, [one, two])).toThrow(/duplicate message ids/);
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBeNull();
  });
});

const SESSION = 'agent:planner:project' as const;
function root(): string { const value = mkdtempSync(join(tmpdir(), 'saivage-conversation-file-')); roots.push(value); initProjectTree(value); return value; }
function truncationFixture(): string { const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!; appendFileSync(cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename), 'suffix'); return projectRoot; }
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', content: id, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }
function projectedText(id: string, privateId: string): AgentMessage { return agentMessageSchema.parse({ ...text(id), role: 'assistant', round_id: `r-assistant-${'0'.repeat(32)}`, provider_projection: { kind: 'openai_responses', source_input_id: '00000000-0000-4000-8000-000000000001', private_message_id: privateId, projection_kind: 'assistant_message' } }); }
function privateRow(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'system', kind: 'provider_private', content: JSON.stringify({ transport: 'openai-responses', source_input_id: '00000000-0000-4000-8000-000000000001', projection_message_id: 'second', provider: 'openai', model: 'test', output: [] }), round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from '@jest/globals';

import { appendConversationBatch, inspectConversationIndex, inspectConversationSegment, restoreConversationIndex, initializeMissingConversation, isConversationCatalogEstablished, readConversation, readConversationCatalog, readCurrentConversationSegment, readHistoricalConversationSegment } from '../../src/persistence/conversation-file.js';
import { consumeGrowingFile } from '../../src/persistence/growing-file.js';
import { cardConversationVersionFile, cardConversationVersionIndexFile, conversationPreviousIndexFile, globalAgentConversationRoot } from '../../src/persistence/layout.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { PublicationOutcomeUnknownError } from '../../src/contracts/index.js';
import { toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { OPERATIONAL_RESULT_POLICY_TEMPLATE } from '../../src/tools/invocation.js';

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('versioned conversation persistence', () => {
  it('purely inspects supplied current and previous index candidates with a torn suffix, leaving all bytes untouched', () => {
    const projectRoot = root(); appendConversationBatch({projectRoot}, [text('first')]);
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    const indexBytes = readFileSync(indexPath); const index = inspectConversationIndex(projectRoot, SESSION, indexBytes);
    const healthy = inspectConversationSegment(projectRoot, SESSION, index)!;
    const torn = Buffer.concat([healthy.bytes, Buffer.from([0xff, 0xe2])]); writeFileSync(healthy.path, torn);
    for (const candidateBytes of [indexBytes, Buffer.from(indexBytes)]) {
      const reads: string[] = [];
      const candidate = inspectConversationIndex(projectRoot, SESSION, candidateBytes);
      const inspected = inspectConversationSegment(projectRoot, SESSION, candidate, undefined, {onRead:p=>reads.push(p)})!;
      expect(reads).toEqual([healthy.path]);
      expect(inspected).toMatchObject({retainedLength:healthy.bytes.length, tornSuffixLength:2});
      expect(inspected.projection.rows).toEqual(healthy.projection.rows);
      expect(readFileSync(healthy.path)).toEqual(torn); expect(readFileSync(indexPath)).toEqual(indexBytes);
    }
    // Explicit selector publication is separate from the later consented tail effect.
    restoreConversationIndex(projectRoot, SESSION, index, 'replacement');
    expect(readFileSync(conversationPreviousIndexFile(indexPath))).toEqual(indexBytes);
    expect(readFileSync(healthy.path)).toEqual(torn);
    expect(readCurrentConversationSegment(projectRoot, SESSION)!.rows).toEqual(healthy.projection.rows);
    expect(readFileSync(healthy.path)).toEqual(healthy.bytes);
  });
  it.each(['empty', 'no-prefix', 'complete-malformed', 'malformed-prefix-and-tail', 'wrong-owner'] as const)('pure inspection refuses %s without tail repair or selector mutation', fault => {
    const projectRoot = root(); appendConversationBatch({projectRoot}, [text('first')]);
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner'); const indexBytes = readFileSync(indexPath);
    const index = inspectConversationIndex(projectRoot, SESSION, indexBytes); const selected = inspectConversationSegment(projectRoot, SESSION, index)!;
    const data = fault === 'empty' ? Buffer.alloc(0) : fault === 'no-prefix' ? Buffer.from('{unfinished') : fault === 'wrong-owner'
      ? Buffer.from(selected.bytes.toString().replaceAll(SESSION, 'agent:executor:project'))
      : Buffer.concat([selected.bytes, Buffer.from(fault === 'complete-malformed' ? '{bad}\n' : '{bad}\nsuffix')]);
    writeFileSync(selected.path, data);
    expect(() => inspectConversationSegment(projectRoot, SESSION, index)).toThrow();
    expect(readFileSync(selected.path)).toEqual(data); expect(readFileSync(indexPath)).toEqual(indexBytes);
    expect(() => inspectConversationIndex(projectRoot, 'agent:executor:project', indexBytes)).toThrow(/identity/);
  });
  it('retains an empty index inode on first ingress, ignores previous on normal reads, and never falls back', () => {
    const projectRoot = root(); const index = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    const previous = conversationPreviousIndexFile(index); const before = readFileSync(index); const inode = statSync(index).ino;
    expect(existsSync(previous)).toBe(false);
    appendConversationBatch({projectRoot}, [text('first')]);
    expect(statSync(previous).ino).toBe(inode); expect(readFileSync(previous)).toEqual(before);
    // Replace (do not corrupt the hardlinked inode in place) to model unrelated previous damage.
    unlinkSync(previous); writeFileSync(previous, 'invalid previous');
    expect(readConversation(projectRoot, SESSION).physicalRows).toHaveLength(1);
    writeFileSync(index, 'invalid current'); expect(() => readConversation(projectRoot, SESSION)).toThrow();
  });
  it('freshly establishes only the exact catalog, including empty indexes, without consuming indexed content', () => {
    const projectRoot = root();
    const index = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    const empty = readFileSync(index);
    expect(isConversationCatalogEstablished(projectRoot, SESSION)).toBe(true);
    unlinkSync(index);
    expect(isConversationCatalogEstablished(projectRoot, SESSION)).toBe(false);
    writeFileSync(index, empty);
    expect(isConversationCatalogEstablished(projectRoot, SESSION)).toBe(true);
    appendConversationBatch({ projectRoot }, [text('first')]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    unlinkSync(cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename));
    expect(isConversationCatalogEstablished(projectRoot, SESSION)).toBe(true);
    expect(() => readConversation(projectRoot, SESSION)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
  });

  it.each(['malformed', 'identity', 'not-directory'] as const)('propagates strict %s catalog failure without changing bytes', (fault) => {
    const projectRoot = root();
    const index = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    if (fault === 'not-directory') {
      const target = globalAgentConversationRoot(projectRoot, 'oversight');
      writeFileSync(target, 'not a directory');
      expect(() => isConversationCatalogEstablished(projectRoot, 'agent:oversight:global')).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
      expect(readFileSync(target, 'utf8')).toBe('not a directory');
      return;
    }
    writeFileSync(index, fault === 'malformed' ? '{invalid' : JSON.stringify({ ...JSON.parse(readFileSync(index, 'utf8')), session_id: 'agent:executor:project' }));
    const before = readFileSync(index);
    expect(() => isConversationCatalogEstablished(projectRoot, SESSION)).toThrow();
    expect(readFileSync(index)).toEqual(before);
  });

  it.each([undefined, 123, null, 'A'.repeat(64), 'a'.repeat(63)])('rejects persisted invalid producer %p at exact consumption without rewriting complete bytes', (producer) => {
    const projectRoot = root();
    const marker = { ...text('activation'), role: 'system' as const, kind: 'activity' as const, context_policy: { kind: 'structural' as const, behavior: 'activation_boundary' as const }, content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp: '2026-08-11T00:00:00.000Z' }) };
    appendConversationBatch({ projectRoot }, [marker, text('first'), privateRow('private'), projectedText('second', 'private')]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    expect(segment.rows.filter(row => row.kind === 'provider_private')).toHaveLength(1);
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename);
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    const envelopes = readFileSync(path, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const row = envelopes.flatMap(envelope => envelope.rows).find((row: AgentMessage) => row.kind === 'provider_private');
    const payload = JSON.parse(row.content);
    if (producer === undefined) delete payload.producer_account_id;
    else payload.producer_account_id = producer;
    row.content = JSON.stringify(payload);
    writeFileSync(path, `${envelopes.map(envelope => JSON.stringify(envelope)).join('\n')}\n`);
    const before = readFileSync(path); const indexBefore = readFileSync(indexPath);
    expect(() => readCurrentConversationSegment(projectRoot, SESSION)).toThrow(/invalid producer account identity/);
    expect(readFileSync(path)).toEqual(before);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });
  it.each([1, 2, 3, 4].flatMap(version => ['index', 'envelope', 'ordinary-genesis'].map(part => ({ version, part }))))('rejects format $version at the exact $part consumer without changing bytes', ({ version, part }) => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    const segmentPath = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename);
    const index = JSON.parse(readFileSync(indexPath, 'utf8'));
    const envelope = JSON.parse(readFileSync(segmentPath, 'utf8'));
    expect(index.format_version).toBe(5);
    expect(envelope.version).toBe(5);
    expect(envelope.rows[0].format_version).toBe(5);
    const path = part === 'index' ? indexPath : segmentPath;
    if (part === 'index') index.format_version = version;
    else if (part === 'envelope') envelope.version = version;
    else envelope.rows[0].format_version = version;
    writeFileSync(path, `${JSON.stringify(part === 'index' ? index : envelope)}\n`);
    const before = readFileSync(path);
    expect(() => readCurrentConversationSegment(projectRoot, SESSION)).toThrow();
    expect(readFileSync(path)).toEqual(before);
  });

  it('lazy establishment tolerates EEXIST usable directory symlinks without a directory proof', () => {
    const projectRoot = root(); const session = 'agent:oversight:global' as const; const target = globalAgentConversationRoot(projectRoot, 'oversight'); const directory = join(projectRoot, 'oversight-directory'); mkdirSync(directory); symlinkSync(directory, target);
    expect(initializeMissingConversation(projectRoot, session)).toBe(true); expect(initializeMissingConversation(projectRoot, session)).toBe(false); expect(readConversationCatalog(projectRoot, session).currentVersion).toBeNull();
  });

  it('lazy establishment propagates non-EEXIST mkdir errors and unusable parent exact-use errors', () => {
    const projectRoot = root(); const session = 'agent:oversight:global' as const;
    expect(() => initializeMissingConversation(join(projectRoot, 'missing'), session)).toThrow(expect.objectContaining({ code: 'ENOENT' }));
    writeFileSync(globalAgentConversationRoot(projectRoot, 'oversight'), 'not a directory');
    expect(() => initializeMissingConversation(projectRoot, session)).toThrow(expect.objectContaining({ code: 'ENOTDIR' }));
  });

  it('publishes incoming rows without a prospective history fold, then rejects invalid durable semantics on consumption', () => {
    const projectRoot = root(); const invalid = { ...text('wrong-session'), session_id: 'agent:executor:project' as const };
    expect(() => appendConversationBatch({ projectRoot }, [text('first'), invalid])).toThrow(/one session/);
    appendConversationBatch({ projectRoot }, [text('first')]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const content = JSON.stringify({ success: true, data: null });
    const malformed = agentMessageSchema.parse({ ...text('00000000-0000-4000-8000-000000000001:tool-result:orphan'), role: 'tool', kind: 'tool_result', tool: 'read', tool_call_id: 'orphan', content, context_policy: toolRowPolicies({ content, template: OPERATIONAL_RESULT_POLICY_TEMPLATE }).result });
    // Row schema and session admission remain enforced independently of conversation semantics.
    expect(() => appendConversationBatch({ projectRoot }, [malformed])).not.toThrow();
    expect(() => readConversation(projectRoot, SESSION)).toThrow();
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBe(segment.entry.version);
  });
  it('retains a configured empty index and publishes ordinary v1 before membership', () => {
    const projectRoot = root(); const effects: unknown[] = [];
    expect(readConversationCatalog(projectRoot, SESSION).currentVersion).toBeNull();
    expect(readConversation(projectRoot, SESSION).physicalRows).toEqual([]);
    appendConversationBatch({ projectRoot, changes: { conversationChanged: (target) => { effects.push(target); }, agentMembershipChanged: (target) => { effects.push(target); } } }, [text('first')]);
    expect(effects).toEqual([{ session_id: SESSION, segment_id: readCurrentConversationSegment(projectRoot, SESSION)!.entry.entry_id, segment_version: 1, visible_message_id: 'first' }, { scope: 'card', cardId: 'project' }]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    expect(segment.genesis.kind).toBe('ordinary_segment_genesis');
    expect(segment.rows.map((row) => row.id)).toEqual(['first']);
    expect(readConversationCatalog(projectRoot, SESSION).versions).toHaveLength(1);
  });

  it('appends one conversation-segment envelope and emits the resulting visible tip', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const effects: unknown[] = [];
    appendConversationBatch({ projectRoot, changes: { conversationChanged: (target) => { effects.push(target); }, agentMembershipChanged() {} } }, [privateRow('private'), projectedText('second', 'private')]);
    expect(effects).toEqual([{ session_id: SESSION, segment_id: readCurrentConversationSegment(projectRoot, SESSION)!.entry.entry_id, segment_version: 1, visible_message_id: 'second' }]);
    const segment = readCurrentConversationSegment(projectRoot, SESSION)!; const lines = readFileSync(cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.type)).toEqual(['conversation-segment', 'conversation-segment']);
    expect(lines[0].rows[0].kind).toBe('ordinary_segment_genesis');
    expect(lines[1].rows.map((row: AgentMessage) => row.id)).toEqual(['private', 'second']);
  });

  it('current-version historical consumption truncates and returns retained rows', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); const canonical = readFileSync(path); appendFileSync(path, '{"unterminated":');
    expect(readHistoricalConversationSegment(projectRoot, SESSION, 1).rows).toEqual(segment.rows);
    expect(readFileSync(path)).toEqual(canonical);
  });

  it('truncates only an unterminated suffix after validating the complete prefix', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); const canonical = readFileSync(path); appendFileSync(path, '{"unterminated":');
    readCurrentConversationSegment(projectRoot, SESSION);
    expect(readFileSync(path)).toEqual(canonical);
    expect(readConversation(projectRoot, SESSION).sourceRows.map((row) => row.id)).toEqual(['first']);
  });

  it.each(['complete-malformed', 'semantic-invalid', 'no-complete-prefix', 'missing-segment', 'genesis-mismatch', 'index-mismatch'] as const)('rejects %s current authority without changing indexed bytes', (fault) => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename);
    const indexPath = cardConversationVersionIndexFile(projectRoot, 'project', 'planner');
    if (fault === 'complete-malformed') appendFileSync(path, '{"complete":"malformed"}\n');
    else if (fault === 'semantic-invalid') appendFileSync(path, `${JSON.stringify({ version: 5, type: 'conversation-segment', rows: [text('first')] })}\nsuffix`);
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
    expect(() => readCurrentConversationSegment(projectRoot, SESSION)).toThrow();
    expect(readFileSync(indexPath)).toEqual(beforeIndex);
    if (beforeSegment) expect(readFileSync(path)).toEqual(beforeSegment);
  });

  it('uses exactly open, ftruncate, fsync, close on successful truncation and does not reread', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]); const segment = readCurrentConversationSegment(projectRoot, SESSION)!;
    const path = cardConversationVersionFile(projectRoot, 'project', 'planner', segment.entry.filename); appendFileSync(path, 'suffix');
    const trace: string[] = [];
    const result = consumeGrowingFile(path, readFileSync(path), () => segment, {
      open() { trace.push('open'); return 7; }, ftruncate() { trace.push('ftruncate'); }, fsync() { trace.push('fsync'); }, close() { trace.push('close'); },
    });
    expect(trace).toEqual(['open', 'ftruncate', 'fsync', 'close']);
    expect(result?.rows.map((row) => row.id)).toEqual(['first']);
  });

  it('keeps open failure direct and makes each post-truncation failure outcome-unknown and final', () => {
    const direct = new Error('open failed');
    const openFixture = truncationFixture();
    expect(() => consumeGrowingFile('exact', Buffer.from('prefix\nsuffix'), () => openFixture, { open() { throw direct; }, ftruncate() {}, fsync() {}, close() {} })).toThrow(direct);
    for (const failed of ['ftruncate', 'fsync', 'close'] as const) {
      const projectRoot = truncationFixture(); const trace: string[] = [];
      const failure = new Error(`${failed} injected`);
      const operation = (name: string): void => { trace.push(name); if (name === failed) throw failure; };
      let thrown: unknown;
      try { consumeGrowingFile('exact', Buffer.from('prefix\nsuffix'), () => projectRoot, {
        open() { trace.push('open'); return 7; }, ftruncate() { operation('ftruncate'); }, fsync() { operation('fsync'); }, close() { operation('close'); },
      }); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(PublicationOutcomeUnknownError);
      expect((thrown as PublicationOutcomeUnknownError).cause).toBe(failure);
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
function text(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'user', kind: 'text', content: id, context_policy: { kind: 'content', storage: 'durable', replacement: { kind: 'retain' }, audience: 'primary_and_summarizer', evidence: { kind: 'none' }, compactable: true }, round_id: `r-user-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }
function projectedText(id: string, privateId: string): AgentMessage { return agentMessageSchema.parse({ ...text(id), role: 'assistant', round_id: `r-assistant-${'0'.repeat(32)}`, provider_projection: { kind: 'openai_responses', source_input_id: '00000000-0000-4000-8000-000000000001', private_message_id: privateId, projection_kind: 'assistant_message' } }); }
function privateRow(id: string): AgentMessage { return agentMessageSchema.parse({ id, session_id: SESSION, role: 'system', kind: 'provider_private', context_policy: { kind: 'structural', behavior: 'responses_private' }, content: JSON.stringify({ transport: 'openai-responses', producer_account_id: 'a'.repeat(64), source_input_id: '00000000-0000-4000-8000-000000000001', projection_message_id: 'second', provider: 'openai', model: 'test', output: [] }), round_id: `r-assistant-${'0'.repeat(32)}`, message_index: 1, block_index: 0, timestamp: '2026-08-11T00:00:00.000Z' }); }

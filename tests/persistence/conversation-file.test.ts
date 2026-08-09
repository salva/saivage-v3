import { appendFileSync, closeSync, existsSync, fstatSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { appendLlmTurnMessageBatch, appendLlmTurnToolCallBatch } from '../../src/runtime/actors/llm-delivery-log.js';
import {
  appendConversationBatch,
  foldConversation,
  readConversation,
  readConversationSummary,
} from '../../src/persistence/conversation-file.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { CanonicalLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';
import { serializeToolCallMessage } from '../../src/contracts/persisted-tool-call.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('conversation file persistence', () => {
  it('keeps direct reads strict while append alone treats ENOENT as an operation-local empty start', () => {
    const projectRoot = root();
    let missing: unknown;
    try { readConversation(projectRoot, 'agent:planner:project'); } catch (error) { missing = error; }
    expect((missing as NodeJS.ErrnoException).code).toBe('ENOENT');

    appendConversationBatch({ projectRoot }, [text('first')]);
    expect(readConversation(projectRoot, 'agent:planner:project').physicalRows.map(({ id }) => id)).toEqual(['first']);
  });

  it('publishes one physical envelope per batch and emits freshness only after publication', () => {
    const projectRoot = root();
    const effects: string[] = [];
    const changes = changesRecording(effects);
    const context = { projectRoot, changes };

    appendConversationBatch(context, [text('first')]);
    expect(effects).toEqual(['conversation:agent:planner:project:first', 'membership:card:project']);
    effects.length = 0;
    appendConversationBatch(context, [text('second'), text('third')]);
    expect(effects).toEqual(['conversation:agent:planner:project:third']);
    expect(readFileSync(conversationFile(projectRoot, 'agent:planner:project'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).rows.map((row: AgentMessage) => row.id))).toEqual([['first'], ['second', 'third']]);
  });

  it('persists a private/visible tool-call pair in one envelope', () => {
    const projectRoot = root();
    const inputId = '00000000-0000-4000-8000-000000000001';
    const input = invocationInput(inputId);
    appendLlmTurnToolCallBatch({ projectRoot }, input, { id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' } }, privateContext(inputId));

    const physical = readConversation(projectRoot, 'agent:planner:project').physicalRows;
    expect(physical.map((row) => row.kind)).toEqual(['provider_private', 'tool_call']);
    expect(JSON.parse(readFileSync(conversationFile(projectRoot, 'agent:planner:project'), 'utf8')).rows).toHaveLength(2);
  });

  it('performs the append before freshness effects', () => {
    const projectRoot = root();
    appendConversationBatch({ projectRoot }, [text('first')]);
    const trace: string[] = [];
    const changes = changesRecording(trace);
    const io: GrowingFileIo = {
      open(path, flags) { trace.push('open'); return openSync(path, flags); },
      stat(fd) { trace.push('stat'); return fstatSync(fd); },
      write: ((...args: unknown[]) => { trace.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { trace.push('fsync'); fsyncSync(fd); },
      close(fd) { trace.push('close'); closeSync(fd); },
    };

    appendConversationBatch({ projectRoot, changes }, [text('second'), text('third'), text('fourth')], { io });
    expect(trace).toEqual([
      'open',
      'stat',
      'write',
      'fsync',
      'close',
      'conversation:agent:planner:project:fourth',
    ]);
  });

  it('fails fast without observation when a previously nonempty conversation is missing at append open', () => {
    const projectRoot = root(); appendConversationBatch({ projectRoot }, [text('first')]);
    const effects: string[] = [];
    const io: GrowingFileIo = {
      open() { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };
    expect(() => appendConversationBatch({ projectRoot, changes: changesRecording(effects) }, [text('second')], { io })).toThrow(/disappeared before append/);
    expect(effects).toEqual([]);
  });

  it('persists an ordinary visible private-projection message', () => {
    const projectRoot = root();
    const inputId = '00000000-0000-4000-8000-000000000002';
    const visible = appendLlmTurnMessageBatch({ projectRoot }, invocationInput(inputId), 'private projection', privateContext(inputId));
    expect(readConversation(projectRoot, 'agent:planner:project').physicalRows).toContainEqual(visible);
  });

  it('rejects continuation and a second call before candidate publication, then admits settlement and continuation', () => {
    const projectRoot = root();
    const effects: string[] = [];
    const context = { projectRoot, changes: changesRecording(effects) };
    const first = toolPair('11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    appendConversationBatch(context, [activation(), first.call]);
    effects.length = 0;
    const publicationTrace: string[] = [];
    const rejectingIo: GrowingFileIo = {
      open() { publicationTrace.push('open'); throw new Error('candidate publication must not open'); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };

    expect(() => appendConversationBatch(context, [text('later')], { io: rejectingIo })).toThrow(/non-final unmatched/);
    const second = toolPair('22222222-2222-4222-8222-222222222222', 'call-2', 'write');
    expect(() => appendConversationBatch(context, [second.call], { io: rejectingIo })).toThrow(/more than one unmatched/);
    expect(publicationTrace).toEqual([]);
    expect(effects).toEqual([]);

    appendConversationBatch(context, [first.result]);
    appendConversationBatch(context, [text('later')]);
    expect(readConversation(projectRoot, 'agent:planner:project').sourceRows.map((row) => row.id)).toEqual(['activation', first.call.id, first.result.id, 'later']);
  });

  it('rejects an invalid first batch before allocating a candidate publication path', () => {
    const projectRoot = root();
    const first = toolPair('11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    const second = toolPair('22222222-2222-4222-8222-222222222222', 'call-2', 'write');
    const publicationTemporaryId = jest.fn(() => 'candidate');

    expect(() => appendConversationBatch(
      { projectRoot },
      [activation(), first.call, second.call],
      { publicationTemporaryId },
    )).toThrow(/more than one unmatched/);
    expect(publicationTemporaryId).not.toHaveBeenCalled();
    expect(existsSync(conversationFile(projectRoot, 'agent:planner:project'))).toBe(false);
  });

  it('retains authorized suffix truncation while rejecting candidate bytes and freshness', () => {
    const projectRoot = root();
    const pair = toolPair('11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    appendConversationBatch({ projectRoot }, [activation(), pair.call]);
    const path = conversationFile(projectRoot, 'agent:planner:project');
    const canonical = readFileSync(path);
    appendFileSync(path, '{"unterminated":');
    const effects: string[] = [];
    const publicationTrace: string[] = [];
    const rejectingIo: GrowingFileIo = {
      open() { publicationTrace.push('open'); throw new Error('candidate publication must not open'); },
      stat: fstatSync, write: writeSync, fsync: fsyncSync, close: closeSync,
    };

    expect(() => appendConversationBatch({ projectRoot, changes: changesRecording(effects) }, [text('later')], { io: rejectingIo })).toThrow(/non-final unmatched/);
    expect(readFileSync(path)).toEqual(canonical);
    expect(publicationTrace).toEqual([]);
    expect(effects).toEqual([]);
  });

  it('rejects one non-final unmatched fixture through array, first-envelope, and complete-fold adapters', () => {
    const projectRoot = root();
    const pair = toolPair('11111111-1111-4111-8111-111111111111', 'call-1', 'read');
    const path = conversationFile(projectRoot, 'agent:planner:project');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ version: 1, type: 'rows', rows: [activation(), pair.call, text('later')] })}\n`);

    expect(() => readConversation(projectRoot, 'agent:planner:project')).toThrow(/non-final unmatched/);
    expect(() => readConversationSummary(projectRoot, 'agent:planner:project')).toThrow(/non-final unmatched/);
    expect(() => foldConversation(projectRoot, 'agent:planner:project')).toThrow(/non-final unmatched/);
  });
});

function root(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-conversation-file-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return projectRoot;
}

function text(id: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: 'agent:planner:project', role: 'user', kind: 'text', content: id, round_id: `r-user-${id === 'first' ? '1' : id === 'second' ? '2' : id === 'third' ? '3' : '4'}${'0'.repeat(31)}`, message_index: 1, block_index: 0, timestamp: '2026-07-19T00:00:00.000Z' });
}

function activation(): AgentMessage {
  const timestamp = '2026-07-19T00:00:00.000Z';
  return agentMessageSchema.parse({ id: 'activation', session_id: 'agent:planner:project', role: 'system', kind: 'activity', content: JSON.stringify({ event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: '00000000-0000-4000-8000-000000000001', timestamp }), round_id: `r-pre-${'0'.repeat(32)}`, message_index: 0, block_index: 0, timestamp });
}

function toolPair(sourceInputId: string, callId: string, tool: string): { call: AgentMessage; result: AgentMessage } {
  const common = { session_id: 'agent:planner:project' as const, round_id: `r-assistant-${'1'.repeat(32)}`, timestamp: '2026-07-19T00:00:01.000Z', tool, tool_call_id: callId };
  return {
    call: agentMessageSchema.parse({ ...common, id: `${sourceInputId}:tool-call:${callId}`, role: 'assistant', kind: 'tool_call', content: JSON.stringify(serializeToolCallMessage({ id: callId, name: tool, args: {} })), message_index: 1, block_index: 0 }),
    result: agentMessageSchema.parse({ ...common, id: `${sourceInputId}:tool-result:${callId}`, role: 'tool', kind: 'tool_result', content: '{"success":true}', message_index: 2, block_index: 0 }),
  };
}

function changesRecording(effects: string[]) {
  return {
    conversationChanged: (sessionId: string, throughMessageId: string) =>
      effects.push(`conversation:${sessionId}:${throughMessageId}`),
    agentMembershipChanged: (
      scope:
        | { scope: 'card'; cardId: string }
        | { scope: 'global-session'; sessionId: string },
    ) =>
      effects.push(
        scope.scope === 'card'
          ? `membership:card:${scope.cardId}`
          : `membership:global:${scope.sessionId}`,
      ),
  };
}

function invocationInput(inputId: string): CanonicalLlmInvocationInput {
  return { inputId, agentId: 'agent:planner:project', agentName: 'planner', sessionId: 'agent:planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'agent:planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {},routePass:{kind:'ordinary',candidateChain:[{provider:'test',account:null,model:'test-model'}]}, episodeContext: {} };
}

function privateContext(sourceInputId: string) {
  return { kind: 'openai_responses' as const, source_input_id: sourceInputId, provider: 'openai', model: 'gpt-test', output: [{ type: 'reasoning' as const, id: `reasoning-${sourceInputId}`, encrypted_content: 'encrypted', summary: [] }] };
}

import { closeSync, fstatSync, fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { appendLlmTurnMessageBatch, appendLlmTurnToolCallBatch } from '../../src/runtime/actors/llm-delivery-log.js';
import {
  appendConversationBatch,
  publishConversationFirstBatch,
  readConversation,
} from '../../src/persistence/conversation-file.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { CanonicalLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('conversation file persistence', () => {
  it('publishes one physical envelope per batch and emits freshness only after publication', () => {
    const projectRoot = root();
    const effects: string[] = [];
    const changes = changesRecording(effects);
    const context = { projectRoot, changes };

    publishConversationFirstBatch(context, [text('first')]);
    expect(effects).toEqual(['conversation:planner:project', 'agents']);
    effects.length = 0;
    appendConversationBatch(context, [text('second'), text('third')]);
    expect(effects).toEqual(['conversation:planner:project', 'agents']);
    expect(readFileSync(conversationFile(projectRoot, 'planner:project'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).rows.map((row: AgentMessage) => row.id))).toEqual([['first'], ['second', 'third']]);
  });

  it('persists a private/visible tool-call pair in one envelope', () => {
    const projectRoot = root();
    const inputId = '00000000-0000-4000-8000-000000000001';
    const input = invocationInput(inputId);
    appendLlmTurnToolCallBatch({ projectRoot }, input, { id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' } }, privateContext(inputId));

    const physical = readConversation(projectRoot, 'planner:project').physicalRows;
    expect(physical.map((row) => row.kind)).toEqual(['provider_private', 'tool_call']);
    expect(JSON.parse(readFileSync(conversationFile(projectRoot, 'planner:project'), 'utf8')).rows).toHaveLength(2);
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
    expect(trace).toEqual(['open', 'stat', 'write', 'fsync', 'close', 'conversation:planner:project', 'agents']);
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
    expect(readConversation(projectRoot, 'planner:project').physicalRows).toContainEqual(visible);
  });
});

function root(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'saivage-conversation-file-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return projectRoot;
}

function text(id: string): AgentMessage {
  return agentMessageSchema.parse({ id, session_id: 'planner:project', role: 'user', kind: 'text', content: id, round_id: `r-user-${id === 'first' ? '1' : id === 'second' ? '2' : id === 'third' ? '3' : '4'}${'0'.repeat(31)}`, message_index: 1, block_index: 0, timestamp: '2026-07-19T00:00:00.000Z' });
}

function changesRecording(effects: string[]) {
  return { agentsChanged: () => effects.push('agents'), conversationChanged: (sessionId: string) => effects.push(`conversation:${sessionId}`) };
}

function invocationInput(inputId: string): CanonicalLlmInvocationInput {
  return { inputId, agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: {} };
}

function privateContext(sourceInputId: string) {
  return { kind: 'openai_responses' as const, source_input_id: sourceInputId, provider: 'openai', model: 'gpt-test', output: [{ type: 'reasoning' as const, id: `reasoning-${sourceInputId}`, encrypted_content: 'encrypted', summary: [] }] };
}

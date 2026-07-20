import { closeSync, fsyncSync, ftruncateSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { ReadModelChangeBroadcaster } from '../../src/application/read-model-changes.js';
import { appendLlmTurnMessageBatch, appendLlmTurnToolCallBatch } from '../../src/runtime/actors/llm-delivery-log.js';
import {
  appendConversationBatch,
  ConversationPostPublicationObservationError,
  publishConversationFirstBatch,
  readConversation,
  type ConversationEntryObservation,
} from '../../src/persistence/conversation-file.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import type { CanonicalLlmInvocationInput } from '../../src/runtime/actors/llm-invocation.js';
import type { GrowingFileIo } from '../../src/persistence/growing-file.js';

const roots: string[] = [];
afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe('conversation append observation boundary', () => {
  it('orders first publication and later append hints before visible observations, once per physical envelope', () => {
    const projectRoot = root();
    const effects: string[] = [];
    const changes = changesRecording(effects);
    const context = { projectRoot, changes, observeEntry: (entry: ConversationEntryObservation) => {
      expect(readConversation(projectRoot, entry.session_id).physicalRows.some((row) => row.id === entry.id)).toBe(true);
      effects.push(`observe:${entry.id}`);
    } };

    publishConversationFirstBatch(context, [text('first')]);
    expect(effects).toEqual(['conversation:planner:project', 'agents', 'observe:first']);
    effects.length = 0;
    appendConversationBatch(context, [text('second'), text('third')]);
    expect(effects).toEqual(['conversation:planner:project', 'agents', 'observe:second', 'observe:third']);
    expect(readFileSync(conversationFile(projectRoot, 'planner:project'), 'utf8').trim().split('\n').map((line) => JSON.parse(line).rows.map((row: AgentMessage) => row.id))).toEqual([['first'], ['second', 'third']]);
  });

  it('persists a private/visible pair in one envelope and exposes only a fresh exact five-field visible observation', () => {
    const projectRoot = root();
    const observed: ConversationEntryObservation[] = [];
    const inputId = '00000000-0000-4000-8000-000000000001';
    const input = invocationInput(inputId);
    const visible = appendLlmTurnToolCallBatch({ projectRoot, observeEntry: (entry) => observed.push(entry) }, input, { id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' } }, privateContext(inputId));

    const physical = readConversation(projectRoot, 'planner:project').physicalRows;
    expect(physical.map((row) => row.kind)).toEqual(['provider_private', 'tool_call']);
    expect(JSON.parse(readFileSync(conversationFile(projectRoot, 'planner:project'), 'utf8')).rows).toHaveLength(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]).not.toBe(visible);
    expect(Object.keys(observed[0]!)).toEqual(['id', 'session_id', 'kind', 'role', 'timestamp']);
    expect(observed[0]).toEqual({ id: visible.id, session_id: visible.session_id, kind: visible.kind, role: visible.role, timestamp: visible.timestamp });
    expect(observed[0]).not.toHaveProperty('content');
    expect(observed[0]).not.toHaveProperty('tool');
    expect(observed[0]).not.toHaveProperty('tool_call_id');
    expect(observed[0]).not.toHaveProperty('provider_projection');
  });

  it('reports observer failure as confirmed post-publication failure and stops ordered observation', () => {
    const projectRoot = root();
    appendConversationBatch({ projectRoot }, [text('first')]);
    const cause = new Error('observer failed');
    const trace: string[] = [];
    const changes = changesRecording(trace);
    const io: GrowingFileIo = {
      open(path, flags) { trace.push('open'); return openSync(path, flags); },
      write: ((...args: unknown[]) => { trace.push('write'); return Reflect.apply(writeSync, undefined, args); }) as typeof writeSync,
      fsync(fd) { trace.push('fsync'); fsyncSync(fd); },
      truncate: ftruncateSync,
      close(fd) { trace.push('close'); closeSync(fd); },
    };

    let thrown: unknown;
    try {
      appendConversationBatch({ projectRoot, changes, observeEntry: (entry) => { trace.push(`observe:${entry.id}`); if (entry.id === 'third') throw cause; } }, [text('second'), text('third'), text('fourth')], { io });
    } catch (error) { thrown = error; }

    expect(thrown).toBeInstanceOf(ConversationPostPublicationObservationError);
    expect(thrown).toMatchObject({ cause, entry: { id: 'third', session_id: 'planner:project' } });
    expect(trace).toEqual(['open', 'write', 'fsync', 'close', 'conversation:planner:project', 'agents', 'observe:second', 'observe:third']);
  });

  it('observes an ordinary visible private-projection message once without exposing its payload', () => {
    const projectRoot = root();
    const observed = jest.fn<(entry: ConversationEntryObservation) => void>();
    const inputId = '00000000-0000-4000-8000-000000000002';
    const visible = appendLlmTurnMessageBatch({ projectRoot, observeEntry: observed }, invocationInput(inputId), 'private projection', privateContext(inputId));
    expect(observed).toHaveBeenCalledTimes(1);
    expect(observed).toHaveBeenCalledWith({ id: visible.id, session_id: visible.session_id, kind: 'text', role: 'assistant', timestamp: visible.timestamp });
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

function changesRecording(effects: string[]): ReadModelChangeBroadcaster {
  const changes = new ReadModelChangeBroadcaster();
  changes.subscribe({ runtimeChanged() {}, cardProjectionChanged() {}, agentsChanged: () => effects.push('agents'), conversationChanged: (sessionId) => effects.push(`conversation:${sessionId}`) });
  return changes;
}

function invocationInput(inputId: string): CanonicalLlmInvocationInput {
  return { inputId, agentId: 'planner:project', role: 'planner', sessionId: 'planner:project', systemPrompt: 'system', providerConversation: { sourceSessionId: 'planner:project', messages: [] }, tools: [], terminalToolNames: [], modelParams: {}, capabilityRequest: {}, episodeContext: {} };
}

function privateContext(sourceInputId: string) {
  return { kind: 'openai_responses' as const, source_input_id: sourceInputId, provider: 'openai', model: 'gpt-test', output: [{ type: 'reasoning' as const, id: `reasoning-${sourceInputId}`, encrypted_content: 'encrypted', summary: [] }] };
}

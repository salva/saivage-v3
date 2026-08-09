import { afterEach, describe, expect, it } from '@jest/globals';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { validateConfiguredAnalystConversation } from '../../src/application/analyst-startup-validation.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { serializeGrowingEnvelope } from '../../src/persistence/growing-file.js';
import { agentMessageSchema, type AgentMessage } from '../../src/schemas/index.js';
import { buildAnalystIngressRows } from '../../src/runtime/actors/conversation-session.js';
import { conversationFile } from '../../src/runtime/actors/conversation-inventory.js';
import { initProjectTree } from '../helpers/canonical-project.js';

const sessionId = 'agent:analyst:global' as const;
const roots: string[] = [];

afterEach(() => { while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true }); });

function root(): string {
  const projectRoot = mkdtempSync(join(tmpdir(), 'analyst-startup-validation-'));
  roots.push(projectRoot);
  initProjectTree(projectRoot);
  return projectRoot;
}

function ingress(inputId = '11111111-1111-4111-8111-111111111111') {
  return buildAnalystIngressRows(sessionId, inputId, 'workspace', 'question');
}

function assistantText(rows: ReturnType<typeof ingress>): AgentMessage {
  return agentMessageSchema.parse({
    ...rows[2],
    id: 'analyst-assistant-text',
    role: 'assistant',
    content: 'completed answer',
    message_index: 3,
  });
}

function toolCall(rows: ReturnType<typeof ingress>, callId: string): AgentMessage {
  const sourceInputId = '11111111-1111-4111-8111-111111111111';
  return agentMessageSchema.parse({
    ...rows[2],
    id: `${sourceInputId}:tool-call:${callId}`,
    role: 'assistant',
    kind: 'tool_call',
    tool: 'webfetch',
    tool_call_id: callId,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [{ id: callId, type: 'function', function: { name: 'webfetch', arguments: '{}' } }],
    }),
    message_index: 3,
  });
}

function toolResult(rows: ReturnType<typeof ingress>, callId: string): AgentMessage {
  const sourceInputId = '11111111-1111-4111-8111-111111111111';
  return agentMessageSchema.parse({
    ...rows[2],
    id: `${sourceInputId}:tool-result:${callId}`,
    role: 'tool',
    kind: 'tool_result',
    tool: 'webfetch',
    tool_call_id: callId,
    content: JSON.stringify({ success: true, data: { status: 'ok' } }),
    message_index: 4,
  });
}

describe('configured Analyst startup validation', () => {
  it('accepts a missing conversation without creating its path', () => {
    const projectRoot = root();
    const path = conversationFile(projectRoot, sessionId);
    expect(existsSync(path)).toBe(false);
    validateConfiguredAnalystConversation(projectRoot, sessionId);
    expect(existsSync(path)).toBe(false);
  });

  it('byte-preserves ordinary text-ended conversation data', () => {
    const projectRoot = root();
    const rows = ingress();
    appendConversationBatch({ projectRoot }, [...rows, assistantText(rows)]);
    const path = conversationFile(projectRoot, sessionId);
    const before = readFileSync(path);
    validateConfiguredAnalystConversation(projectRoot, sessionId);
    expect(readFileSync(path)).toEqual(before);
  });

  it('byte-preserves an ambiguous user-text ending without inferring interruption', () => {
    const projectRoot = root();
    appendConversationBatch({ projectRoot }, ingress());
    const path = conversationFile(projectRoot, sessionId);
    const before = readFileSync(path);
    validateConfiguredAnalystConversation(projectRoot, sessionId);
    expect(readFileSync(path)).toEqual(before);
  });

  it('byte-preserves settled tool conversation data', () => {
    const projectRoot = root();
    const rows = ingress();
    appendConversationBatch({ projectRoot }, [...rows, toolCall(rows, 'call-1'), toolResult(rows, 'call-1')]);
    const path = conversationFile(projectRoot, sessionId);
    const before = readFileSync(path);
    validateConfiguredAnalystConversation(projectRoot, sessionId);
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects a sole final unmatched call without mutation', () => {
    const projectRoot = root();
    const rows = ingress();
    appendConversationBatch({ projectRoot }, [...rows, toolCall(rows, 'call-1')]);
    const path = conversationFile(projectRoot, sessionId);
    const before = readFileSync(path);
    expect(() => validateConfiguredAnalystConversation(projectRoot, sessionId)).toThrow('cannot be continued after startup');
    expect(readFileSync(path)).toEqual(before);
  });

  it('rejects complete semantically invalid data without mutation', () => {
    const projectRoot = root();
    const rows = ingress();
    appendConversationBatch({ projectRoot }, [...rows, toolCall(rows, 'call-1')]);
    const path = conversationFile(projectRoot, sessionId);
    appendFileSync(path, serializeGrowingEnvelope([toolCall(rows, 'call-2')], agentMessageSchema));
    const before = readFileSync(path);
    expect(() => validateConfiguredAnalystConversation(projectRoot, sessionId)).toThrow('Conversation contains more than one unmatched tool call');
    expect(readFileSync(path)).toEqual(before);
  });

  it('retains only canonical reader truncation of an unterminated final suffix', () => {
    const projectRoot = root();
    const rows = ingress();
    appendConversationBatch({ projectRoot }, [...rows, assistantText(rows)]);
    const path = conversationFile(projectRoot, sessionId);
    const complete = readFileSync(path);
    appendFileSync(path, '{"version":1');
    validateConfiguredAnalystConversation(projectRoot, sessionId);
    expect(readFileSync(path)).toEqual(complete);
  });
});

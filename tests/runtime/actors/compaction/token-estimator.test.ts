import { describe, expect, it } from '@jest/globals';

import { agentMessageSchema, type AgentMessage } from '../../../../src/schemas/index.js';
import { shouldCompact } from '../../../../src/runtime/actors/compaction/compactor.js';
import { estimateMessageTokens } from '../../../../src/runtime/actors/compaction/round-classifier.js';
import { estimateUtf8Tokens } from '../../../../src/runtime/actors/compaction/token-estimator.js';
import type { PreparedLlmInvocationInput } from '../../../../src/runtime/actors/llm-invocation.js';
import { TEXT_ROW_POLICY } from '../../../helpers/row-policy-fixtures.js';

const SESSION = 'agent:planner:project' as const;
const ROUND_ID = `r-user-${'0'.repeat(32)}`;

describe('UTF-8 compaction token estimation', () => {
  it('uses aggregate four-byte rounding for ASCII text', () => {
    expect(estimateUtf8Tokens('')).toBe(0);
    expect(estimateUtf8Tokens('abcd')).toBe(1);
    expect(estimateUtf8Tokens('abcde')).toBe(2);
  });

  it('counts multibyte BMP and astral text by UTF-8 bytes rather than UTF-16 code units', () => {
    expect(estimateUtf8Tokens('漢字')).toBe(2);
    expect(Math.ceil('漢字'.length / 4)).toBe(1);
    expect(estimateUtf8Tokens('😀😀')).toBe(2);
    expect(Math.ceil('😀😀'.length / 4)).toBe(1);
  });

  it('combines projected content and structural fields before one byte-derived rounding', () => {
    const message = textMessage('漢');
    const structural = [
      message.role,
      message.kind,
      message.tool,
      message.tool_call_id,
      message.round_id,
    ]
      .filter(Boolean)
      .join(' ');

    expect(estimateMessageTokens(message)).toBe(
      Math.max(1, estimateUtf8Tokens(message.content + structural)),
    );
    expect(estimateMessageTokens(message)).not.toBe(
      estimateUtf8Tokens(message.content) + estimateUtf8Tokens(structural),
    );
  });

  it('assigns provider-private rows zero and keeps tiny visible rows at one or more', () => {
    expect(estimateMessageTokens(providerPrivateMessage())).toBe(0);
    expect(estimateMessageTokens(textMessage(''))).toBeGreaterThanOrEqual(1);
  });

  it('compacts inclusively at a non-ASCII boundary that UTF-16 weighting misses', () => {
    const message = textMessage('😀'.repeat(8));
    const structural = [
      message.role,
      message.kind,
      message.tool,
      message.tool_call_id,
      message.round_id,
    ]
      .filter(Boolean)
      .join(' ');
    const utf8Estimate = estimateUtf8Tokens(message.content + structural);
    const oldUtf16Estimate = Math.ceil((message.content.length + structural.length) / 4);
    const input = {
      providerConversation: { sourceSessionId: SESSION, messages: [message] },
      preparedCompaction: { triggerMessageThreshold: utf8Estimate },
    } as unknown as PreparedLlmInvocationInput;

    expect(oldUtf16Estimate).toBeLessThan(utf8Estimate);
    expect(estimateMessageTokens(message)).toBe(utf8Estimate);
    expect(shouldCompact(input)).toBe(true);
  });
});

function textMessage(content: string): AgentMessage {
  return agentMessageSchema.parse({
    id: `text-${content.length}`,
    session_id: SESSION,
    role: 'user',
    kind: 'text',
    content,
    context_policy: TEXT_ROW_POLICY,
    round_id: ROUND_ID,
    message_index: 0,
    block_index: 0,
    timestamp: '2026-09-02T00:00:00.000Z',
  });
}

function providerPrivateMessage(): AgentMessage {
  return agentMessageSchema.parse({
    id: 'provider-private',
    session_id: SESSION,
    role: 'system',
    kind: 'provider_private',
    content: JSON.stringify({
      transport: 'openai-responses',
      source_input_id: '00000000-0000-4000-8000-000000000001',
      projection_message_id: 'visible-message',
      provider: 'openai',
      model: 'test',
      output: [],
    }),
    context_policy: { kind: 'structural', behavior: 'responses_private' },
    round_id: `r-assistant-${'0'.repeat(32)}`,
    message_index: 0,
    block_index: 0,
    timestamp: '2026-09-02T00:00:00.000Z',
  });
}

import { describe, expect, it, jest } from '@jest/globals';

import { projectCanonicalConversationRow } from '../../src/application/read-models/canonical-conversation-outbound.js';
import type {
  ToolInvocationProjectionInput,
  ToolInvocationProjector,
} from '../../src/contracts/tool-invocation-projection.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';

const timestamp = '2026-07-22T10:00:00.000Z';
const source = '11111111-1111-4111-8111-111111111111';
const sessionId = 'agent:planner:project' as const;
const identityProjector: ToolInvocationProjector = (input) => input;

const classifiedProjector: ToolInvocationProjector = (input) => {
  if (input.shape === 'call-row') {
    return { ...input, arguments: input.arguments.replaceAll('tok_secret', '[REDACTED]') };
  }
  if (input.shape === 'result-row') {
    return input.result.success
      ? { ...input, result: { ...input.result, data: { projected: true } } }
      : {
          ...input,
          result: {
            ...input.result,
            error: input.result.error.replaceAll('tok_secret', '[REDACTED]'),
          },
        };
  }
  return input;
};

describe('canonical conversation outbound row projection', () => {
  it('redacts ordinary prose and removes provider/model decoration', () => {
    const projected = projectCanonicalConversationRow(ordinary(), identityProjector);
    expect(projected).toMatchObject({
      id: 'ordinary-row',
      links: [{ entity_id: 'structural-identity' }],
    });
    expect(projected).not.toHaveProperty('model_spec');
    expect(projected).not.toHaveProperty('requested_model_spec');
    expect(projected.content).not.toContain('tok_secret');
    expect(projected.links?.[0]?.label).not.toContain('tok_secret');
  });

  it('derives call identity from its row and invents no result', () => {
    const callback = jest.fn(classifiedProjector);
    const projected = projectCanonicalConversationRow(
      call({ arguments: 'malformed tok_secret' }),
      callback,
    );
    expect(callback).toHaveBeenCalledWith({
      shape: 'call-row',
      identity: {
        sessionId,
        sourceInputId: source,
        toolCallId: 'call-a',
        toolName: 'webfetch',
        startedAt: timestamp,
      },
      arguments: 'malformed tok_secret',
    });
    expect(JSON.parse(projected.content).tool_calls[0].function.arguments).toBe(
      'malformed [REDACTED]',
    );
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty('result');
  });

  it('treats durable result data as opaque and applies only projector redaction', () => {
    const callback = jest.fn(classifiedProjector);
    const projected = projectCanonicalConversationRow(result(), callback);
    expect(callback).toHaveBeenCalledWith({
      shape: 'result-row',
      identity: {
        sessionId,
        sourceInputId: source,
        toolCallId: 'call-a',
        toolName: 'webfetch',
      },
      result: {
        success: false,
        error: 'failed tok_secret',
        data: { historical_wrapper: ['unchanged'] },
      },
    });
    expect(JSON.parse(projected.content)).toEqual({
      success: false,
      error: 'failed [REDACTED]',
      data: { historical_wrapper: ['unchanged'] },
    });
  });

  it('fails malformed row content, embedded identity mismatch, and projector identity changes', () => {
    expect(() =>
      projectCanonicalConversationRow({ ...call(), content: '{' }, identityProjector),
    ).toThrow('malformed embedded content');
    expect(() =>
      projectCanonicalConversationRow(
        {
          ...call(),
          content: JSON.stringify({
            role: 'assistant',
            tool_calls: [
              {
                id: 'wrong',
                type: 'function',
                function: { name: 'webfetch', arguments: '{}' },
              },
            ],
          }),
        },
        identityProjector,
      ),
    ).toThrow('embedded identity');
    expect(() =>
      projectCanonicalConversationRow({ ...result(), content: '{' }, identityProjector),
    ).toThrow('malformed content');
    const changingProjector: ToolInvocationProjector = (input) =>
      ({
        ...input,
        identity: { ...input.identity, toolName: 'wrong' },
      }) as ToolInvocationProjectionInput;
    expect(() => projectCanonicalConversationRow(call(), changingProjector)).toThrow(
      'changed canonical call-row shape or identity',
    );
  });
});

function call(
  options: {
    session?: ConversationSessionId;
    arguments?: string;
  } = {},
): AgentMessage {
  const toolCallId = 'call-a';
  const tool = 'webfetch';
  return {
    id: `${source}:tool-call:${toolCallId}`,
    session_id: options.session ?? sessionId,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: toolCallId,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [
        {
          id: toolCallId,
          type: 'function',
          function: {
            name: tool,
            arguments: options.arguments ?? '{"url":"https://example.test/?token=tok_secret"}',
          },
        },
      ],
    }),
    round_id: `r-assistant-${source.replaceAll('-', '')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
    model_spec: 'private-model',
  };
}

function result(): AgentMessage {
  return {
    id: `${source}:tool-result:call-a`,
    session_id: sessionId,
    role: 'tool',
    kind: 'tool_result',
    tool: 'webfetch',
    tool_call_id: 'call-a',
    content: JSON.stringify({
      success: false,
      error: 'failed tok_secret',
      data: { historical_wrapper: ['unchanged'] },
    }),
    round_id: `r-assistant-${source.replaceAll('-', '')}`,
    message_index: 1,
    block_index: 0,
    timestamp,
  };
}

function ordinary(): AgentMessage {
  return {
    id: 'ordinary-row',
    session_id: sessionId,
    role: 'assistant',
    kind: 'text',
    content: 'message tok_secret',
    round_id: `r-assistant-${source.replaceAll('-', '')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
    model_spec: 'private-model',
    requested_model_spec: 'private-requested-model',
    links: [
      {
        entity_type: 'process',
        entity_id: 'structural-identity',
        label: 'label tok_secret',
      },
    ],
  };
}

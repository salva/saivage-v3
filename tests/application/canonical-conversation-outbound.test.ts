import { describe, expect, it, jest } from '@jest/globals';

import {
  projectBoundedAgentSessionWrapper,
  projectCanonicalConversationRow,
  projectCompleteCanonicalConversation,
  type BoundedAgentSessionWrapper,
  type ExactResultAbsentDeclaration,
} from '../../src/application/read-models/canonical-conversation-outbound.js';
import type {
  ToolInvocationProjectionInput,
  ToolInvocationProjector,
} from '../../src/contracts/tool-invocation-projection.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import {
  credentialShapedCard,
  OUTBOUND_IDENTITY,
  OUTBOUND_RAW_MARKER,
  OUTBOUND_REDACTED_URL,
  OUTBOUND_URL,
} from '../helpers/outbound-identity-fixtures.js';

const timestamp = '2026-07-22T10:00:00.000Z';
const sourceA = '11111111-1111-4111-8111-111111111111';
const sourceB = '22222222-2222-4222-8222-222222222222';
const sessionId = 'agent:planner:project' as const;

const identityProjector: ToolInvocationProjector = (input) => input;

const classifiedProjector: ToolInvocationProjector = (input) => {
  if (input.shape === 'call-row') {
    return { ...input, arguments: input.arguments.replaceAll('tok_secret', '[REDACTED]') };
  }
  if (input.shape === 'result-row') {
    return input.result.success
      ? { ...input, result: { ...input.result, data: { projected: true } } }
      : { ...input, result: { ...input.result, error: input.result.error.replaceAll('tok_secret', '[REDACTED]') } };
  }
  return input;
};

function call(options: {
  source?: string;
  callId?: string;
  tool?: string;
  session?: ConversationSessionId;
  messageIndex?: number;
  arguments?: string;
  timestamp?: string;
} = {}): AgentMessage {
  const source = options.source ?? sourceA;
  const callId = options.callId ?? 'call-a';
  const tool = options.tool ?? 'webfetch';
  const session = options.session ?? sessionId;
  return {
    id: `${source}:tool-call:${callId}`,
    session_id: session,
    role: 'assistant',
    kind: 'tool_call',
    tool,
    tool_call_id: callId,
    content: JSON.stringify({
      role: 'assistant',
      tool_calls: [{ id: callId, type: 'function', function: { name: tool, arguments: options.arguments ?? '{"url":"https://example.test/?token=tok_secret"}' } }],
    }),
    round_id: `r-assistant-${source.replaceAll('-', '')}`,
    message_index: options.messageIndex ?? 0,
    block_index: 0,
    timestamp: options.timestamp ?? timestamp,
  };
}

function result(options: {
  source?: string;
  callId?: string;
  tool?: string;
  session?: ConversationSessionId;
  messageIndex?: number;
  content?: string;
} = {}): AgentMessage {
  const source = options.source ?? sourceA;
  const callId = options.callId ?? 'call-a';
  return {
    id: `${source}:tool-result:${callId}`,
    session_id: options.session ?? sessionId,
    role: 'tool',
    kind: 'tool_result',
    tool: options.tool ?? 'webfetch',
    tool_call_id: callId,
    content: options.content ?? '{"success":false,"error":"failed tok_secret"}',
    round_id: `r-assistant-${source.replaceAll('-', '')}`,
    message_index: options.messageIndex ?? 1,
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
    round_id: `r-assistant-${sourceA.replaceAll('-', '')}`,
    message_index: 0,
    block_index: 0,
    timestamp,
    model_spec: 'tok_primary',
    links: [{ entity_type: 'process', entity_id: 'tok_primary', label: 'label tok_secret' }],
  };
}

function declaration(state: ExactResultAbsentDeclaration['state'] = 'active-in-flight'): ExactResultAbsentDeclaration {
  return { state, sessionId, sourceInputId: sourceA, toolCallId: 'call-a', toolName: 'webfetch', startedAt: timestamp };
}

function wrapper(
  status: 'active' | 'waiting' | 'inactive',
  messages: AgentMessage[],
  pending = status === 'waiting' ? [{ id: 'call-a', tool: 'webfetch', started_at: timestamp }] : [],
): BoundedAgentSessionWrapper {
  return {
    session: { id: sessionId, agent_name: 'planner', session_scope:'card', card_id: 'project', status, started_at: timestamp, model: 'tok_primary' },
    activity_status: { status, pending_calls: pending },
    total_messages: 9,
    returned: messages.length,
    parse_errors: 0,
    messages,
  };
}

describe('canonical conversation outbound row projection', () => {
  it('projects ordinary prose while preserving row, model, and entity identities', () => {
    const projected = projectCanonicalConversationRow(ordinary(), identityProjector);
    expect(projected).toMatchObject({ id: 'ordinary-row', model_spec: 'tok_primary', links: [{ entity_id: 'tok_primary' }] });
    expect(projected.content).not.toContain('tok_secret');
    expect(projected.links?.[0]?.label).not.toContain('tok_secret');
  });

  it('derives call identity from its own row, retains raw malformed arguments, and invents no result', () => {
    const callback = jest.fn(classifiedProjector);
    const projected = projectCanonicalConversationRow(call({ arguments: 'malformed tok_secret' }), callback);
    expect(callback).toHaveBeenCalledWith({
      shape: 'call-row',
      identity: { sessionId, sourceInputId: sourceA, toolCallId: 'call-a', toolName: 'webfetch', startedAt: timestamp },
      arguments: 'malformed tok_secret',
    });
    const embedded = JSON.parse(projected.content);
    expect(embedded.tool_calls[0].function.arguments).toBe('malformed [REDACTED]');
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty('result');
  });

  it('derives result identity from its own row, strictly projects ToolResult, and invents no arguments', () => {
    const callback = jest.fn(classifiedProjector);
    const projected = projectCanonicalConversationRow(result(), callback);
    expect(callback).toHaveBeenCalledWith({
      shape: 'result-row',
      identity: { sessionId, sourceInputId: sourceA, toolCallId: 'call-a', toolName: 'webfetch' },
      result: { success: false, error: 'failed tok_secret' },
    });
    expect(JSON.parse(projected.content)).toEqual({ success: false, error: 'failed [REDACTED]' });
    expect(callback.mock.calls[0]?.[0]).not.toHaveProperty('arguments');
  });

  it('fails malformed own call/result content, embedded identity mismatch, and callback identity changes', () => {
    expect(() => projectCanonicalConversationRow({ ...call(), id: 'noncanonical-call-id' }, identityProjector)).toThrow();
    expect(() => projectCanonicalConversationRow({ ...call(), content: '{' }, identityProjector)).toThrow('malformed embedded content');
    expect(() => projectCanonicalConversationRow({ ...call(), role: 'user' }, identityProjector)).toThrow('must use assistant role');
    expect(() => projectCanonicalConversationRow({ ...call(), content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'wrong', type: 'function', function: { name: 'webfetch', arguments: '{}' } }] }) }, identityProjector)).toThrow('embedded identity');
    expect(() => projectCanonicalConversationRow({ ...result(), content: '{' }, identityProjector)).toThrow('malformed content');
    expect(() => projectCanonicalConversationRow({ ...result(), id: 'noncanonical-result-id' }, identityProjector)).toThrow();
    expect(() => projectCanonicalConversationRow({ ...result(), role: 'assistant' }, identityProjector)).toThrow('must use tool role');
    expect(() => projectCanonicalConversationRow({ ...result(), content: '{"success":true,"error":"not allowed"}' }, identityProjector)).toThrow('malformed content');
    const changingCallback: ToolInvocationProjector = (input) => ({ ...input, identity: { ...input.identity, toolName: 'wrong' } } as ToolInvocationProjectionInput);
    expect(() => projectCanonicalConversationRow(call(), changingCallback)).toThrow('changed canonical call-row identity');
    const callResultInventor: ToolInvocationProjector = (input) => ({ ...input, result: { success: true } } as ToolInvocationProjectionInput);
    expect(() => projectCanonicalConversationRow(call(), callResultInventor)).toThrow('invented a result');
    const resultArgumentInventor: ToolInvocationProjector = (input) => ({ ...input, arguments: '{}' } as ToolInvocationProjectionInput);
    expect(() => projectCanonicalConversationRow(result(), resultArgumentInventor)).toThrow('invented arguments');
  });
});

describe('complete canonical conversation projection', () => {
  it('accepts and projects a complete exact pair', () => {
    const projected = projectCompleteCanonicalConversation([call(), result()], undefined, classifiedProjector);
    expect(projected).toHaveLength(2);
    expect(JSON.parse(projected[0]!.content).tool_calls[0].function.arguments).not.toContain('tok_secret');
    expect(JSON.parse(projected[1]!.content).error).not.toContain('tok_secret');
  });

  it.each(['active-in-flight', 'waiting'] as const)('accepts the sole exact %s declaration', (state) => {
    expect(projectCompleteCanonicalConversation([call()], declaration(state), identityProjector)).toHaveLength(1);
  });

  it('rejects inactive/undeclared orphans, a second orphan, and mismatched declarations', () => {
    expect(() => projectCompleteCanonicalConversation([call()], undefined, identityProjector)).toThrow('undeclared result-absent');
    expect(() => projectCompleteCanonicalConversation([
      call(),
      call({ source: sourceB, callId: 'call-b', messageIndex: 1 }),
    ], declaration(), identityProjector)).toThrow('more than one result-absent');
    expect(() => projectCompleteCanonicalConversation([call()], { ...declaration(), toolName: 'wrong' }, identityProjector)).toThrow('does not match');
    expect(() => projectCompleteCanonicalConversation([call()], { ...declaration(), startedAt: '2026-07-22T10:00:01.000Z' }, identityProjector)).toThrow('does not match');
  });

  it('rejects result-present declarations, missing/prior mates, duplicates, and pair tool mismatch', () => {
    expect(() => projectCompleteCanonicalConversation([call(), result()], declaration(), identityProjector)).toThrow('sole unmatched');
    expect(() => projectCompleteCanonicalConversation([result()], undefined, identityProjector)).toThrow('no prior matching call');
    expect(() => projectCompleteCanonicalConversation([call(), call()], undefined, identityProjector)).toThrow('Duplicate tool call');
    expect(() => projectCompleteCanonicalConversation([call(), result(), result()], undefined, identityProjector)).toThrow('duplicate settlements');
    expect(() => projectCompleteCanonicalConversation([call(), result({ tool: 'websearch' })], undefined, identityProjector)).toThrow('mismatched call/result tool');
  });
});

describe('bounded read_agent_session wrapper projection', () => {
  it.each(['inactive', 'active'] as const)('accepts an isolated selected result for %s without treating it as pending', (status) => {
    const projected = projectBoundedAgentSessionWrapper(wrapper(status, [result()]), classifiedProjector);
    expect(projected.messages).toHaveLength(1);
    expect(projected.activity_status.pending_calls).toEqual([]);
  });

  it('rejects inactive call-only and accepts active zero or one call-only without invention', () => {
    expect(() => projectBoundedAgentSessionWrapper(wrapper('inactive', [call()]), identityProjector)).toThrow('Inactive bounded session');
    expect(projectBoundedAgentSessionWrapper(wrapper('active', [ordinary()]), identityProjector).messages).toHaveLength(1);
    const projected = projectBoundedAgentSessionWrapper(wrapper('active', [call()]), classifiedProjector);
    expect(projected.activity_status.pending_calls).toEqual([]);
    expect(projected.messages[0]).not.toHaveProperty('result');
    expect(JSON.parse(projected.messages[0]!.content).tool_calls[0].function.arguments).not.toContain('tok_secret');
  });

  it('rejects two active call-only rows', () => {
    expect(() => projectBoundedAgentSessionWrapper(wrapper('active', [
      call(),
      call({ source: sourceB, callId: 'call-b', messageIndex: 1 }),
    ]), identityProjector)).toThrow('more than one result-absent');
  });

  it('accepts exactly the waiting call-only row matching the sole public pending row', () => {
    const projected = projectBoundedAgentSessionWrapper(wrapper('waiting', [call()]), classifiedProjector);
    expect(projected.activity_status.pending_calls).toEqual([{ id: 'call-a', tool: 'webfetch', started_at: timestamp }]);
    expect(projected.messages).toHaveLength(1);
  });

  it('rejects waiting result-only, missing pending, wrong call, and an additional call-only row', () => {
    expect(() => projectBoundedAgentSessionWrapper(wrapper('waiting', [result()]), identityProjector)).toThrow('requires exactly one selected');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('waiting', [call()], []), identityProjector)).toThrow();
    expect(() => projectBoundedAgentSessionWrapper(wrapper('waiting', [call({ tool: 'websearch' })]), identityProjector)).toThrow('does not match');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('waiting', [
      call(),
      call({ source: sourceB, callId: 'call-b', messageIndex: 1 }),
    ]), identityProjector)).toThrow('requires exactly one selected');
  });

  it('accepts an isolated result followed by the exact waiting call', () => {
    const selected = [
      result({ source: sourceB, callId: 'call-before-boundary', messageIndex: 7 }),
      call({ messageIndex: 8 }),
    ];
    const projected = projectBoundedAgentSessionWrapper(wrapper('waiting', selected), classifiedProjector);
    expect(projected.messages.map((message) => message.id)).toEqual(selected.map((message) => message.id));
  });

  it('accepts a selected complete pair and preserves exact counts, ordering, and boundary', () => {
    const selected = [call({ messageIndex: 7 }), result({ messageIndex: 8 })];
    const projected = projectBoundedAgentSessionWrapper(wrapper('inactive', selected), identityProjector);
    expect(projected).toMatchObject({ total_messages: 9, returned: 2, parse_errors: 0 });
    expect(projected.messages.map((message) => message.id)).toEqual(selected.map((message) => message.id));
  });

  it('rejects wrapper/session/count mismatch, duplicate rows, result-before-call, and co-selected tool mismatch', () => {
    expect(() => projectBoundedAgentSessionWrapper({ ...wrapper('inactive', [result()]), returned: 0 }, identityProjector)).toThrow('Returned count');
    expect(() => projectBoundedAgentSessionWrapper({ ...wrapper('inactive', [result()]), total_messages: 0 }, identityProjector)).toThrow('Total message count');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('inactive', [result({ session: 'agent:reviewer:project' })]), identityProjector)).toThrow('Selected message session');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('inactive', [result(), result()]), identityProjector)).toThrow('duplicate settlements');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('inactive', [result(), call()]), identityProjector)).toThrow('precedes its selected call');
    expect(() => projectBoundedAgentSessionWrapper(wrapper('inactive', [call(), result({ tool: 'websearch' })]), identityProjector)).toThrow('mismatched call/result tool');
  });

  it('enforces every asymmetric suffix case identically in direct and nested bounded wrappers', () => {
    const accepted = [
      wrapper('inactive', [result()]),
      wrapper('active', [result()]),
      wrapper('active', [ordinary()]),
      wrapper('active', [call({ arguments: JSON.stringify({ url: OUTBOUND_URL }) })]),
      wrapper('waiting', [call({ arguments: JSON.stringify({ url: OUTBOUND_URL }) })]),
      wrapper('waiting', [result({ source: sourceB, callId: 'call-before-boundary', messageIndex: 7 }), call({ messageIndex: 8 })]),
      wrapper('inactive', [call(), result()]),
    ];
    for (const value of accepted) {
      const direct = projectBoundedAgentSessionWrapper(value, projectToolInvocation);
      expect(projectNestedWrapper(value)).toEqual(direct);
      expect(JSON.stringify(direct)).not.toContain(OUTBOUND_RAW_MARKER);
    }
    const activeCall = projectBoundedAgentSessionWrapper(accepted[3]!, projectToolInvocation);
    expect(activeCall.activity_status.pending_calls).toEqual([]);
    expect(activeCall.messages[0]!.content).toContain(OUTBOUND_REDACTED_URL);
    expect(activeCall.messages[0]).not.toHaveProperty('result');

    const rejected = [
      wrapper('inactive', [call()]),
      wrapper('active', [call(), call({ source: sourceB, callId: 'call-b', messageIndex: 1 })]),
      wrapper('waiting', [result()]),
      wrapper('waiting', [call()], []),
      wrapper('waiting', [call({ tool: 'websearch' })]),
      wrapper('waiting', [call(), call({ source: sourceB, callId: 'call-b', messageIndex: 1 })]),
    ];
    for (const value of rejected) {
      expect(() => projectBoundedAgentSessionWrapper(value, projectToolInvocation)).toThrow();
      expect(() => projectNestedWrapper(value)).toThrow();
    }
  });

  it('preserves the shared list_cards tag and matching card through conversation and bounded-session rows', () => {
    const listCall = call({ tool: 'list_cards', arguments: JSON.stringify({ tag: OUTBOUND_IDENTITY }), messageIndex: 7 });
    const listResult = result({
      tool: 'list_cards', messageIndex: 8,
      content: JSON.stringify({ success: true, data: [credentialShapedCard()] }),
    });
    const aggregate = projectCompleteCanonicalConversation([listCall, listResult], undefined, projectToolInvocation);
    const direct = projectBoundedAgentSessionWrapper(wrapper('inactive', aggregate), projectToolInvocation);
    const nested = projectNestedWrapper(wrapper('inactive', aggregate));
    expect(nested).toEqual(direct);
    const projectedArguments = JSON.parse(JSON.parse(direct.messages[0]!.content).tool_calls[0].function.arguments);
    const projectedResult = JSON.parse(direct.messages[1]!.content);
    expect(projectedArguments).toEqual({ tag: OUTBOUND_IDENTITY });
    expect(projectedResult).toMatchObject({ success: true, data: [{ id: 'card-token', tags: [OUTBOUND_IDENTITY], title: 'title token=[REDACTED]' }] });
    expect(JSON.stringify(direct)).not.toContain(OUTBOUND_RAW_MARKER);
  });
});

function projectNestedWrapper(value: BoundedAgentSessionWrapper): BoundedAgentSessionWrapper {
  const projected = projectToolInvocation({
    shape: 'result-row',
    identity: {
      sessionId: 'agent:analyst:global',
      sourceInputId: sourceB,
      toolCallId: 'nested-session',
      toolName: 'read_agent_session',
    },
    result: { success: true, data: value },
  });
  if (projected.shape !== 'result-row' || !projected.result.success) throw new Error('Expected nested bounded-session projection.');
  return projected.result.data as BoundedAgentSessionWrapper;
}

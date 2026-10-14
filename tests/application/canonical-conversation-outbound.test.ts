import { describe, expect, it, jest } from '@jest/globals';

import { projectCanonicalConversationRow } from '../../src/application/read-models/canonical-conversation-outbound.js';
import { redactTextForOutbound } from '../../src/redaction/index.js';
import type {
  ToolInvocationProjectionInput,
  ToolInvocationProjector,
} from '../../src/contracts/tool-invocation-projection.js';
import type { AgentMessage, ConversationSessionId } from '../../src/schemas/index.js';
import { TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import { historicalOpaqueToolResults } from '../fixtures/historical-opaque-tool-results.js';
import { foldHistoricalConversationRows } from '../../src/application/read-models/agent-conversation-read-model.js';
import { responsesBundle, RESPONSES_A } from '../helpers/responses-producer-fixture.js';
import { agentMessageSchema, parseActivationOpenPayload, STRUCTURAL_ROW_POLICY } from '../../src/schemas/index.js';
import { AgentConversationEntrySchema } from '../../src/contracts/operator-api-agents.js';
import { OUTBOUND_URL, OUTBOUND_REDACTED_URL, OUTBOUND_RAW_MARKER } from '../helpers/outbound-identity-fixtures.js';

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
  it.each([
    'Notes\n  api_key: "SYNTHETIC_CANARY"\r\nFINAL-SAFE-Z',
    '{"api_key"\t:\n"SYNTHETIC_CANARY\\\\path\\"quote"}\nFINAL-SAFE-Z',
    '\tghp_SYNTHETIC_CANARY\nFINAL-SAFE-Z',
    '\nsk-SYNTHETIC_CANARY.\nFINAL-SAFE-Z',
    '\nsk-SYNTHETIC_CANARY\b\nFINAL-SAFE-Z',
    '\nBearer\tSYNTHETIC_CANARY\nFINAL-SAFE-Z',
    String.raw`\"api_key\": \"SYNTHETIC_CANARY\"` + '\nFINAL-SAFE-Z',
    '\tapi_key="SYNTHETIC_CANARY"\nFINAL-SAFE-Z',
    'https://example.test/?api_key=SYNTHETIC_CANARY\nFINAL-SAFE-Z',
    'Notes\\\napi_key: SYNTHETIC_CANARY\nFINAL-SAFE-Z',
    "api_key='SYNTHETIC_CANARY'\nFINAL-SAFE-Z",
    'api_key=SYNTHETIC_CANARY\nFINAL-SAFE-Z',
    'https://example.test/?custom-token-key=SYNTHETIC_CANARY\nFINAL-SAFE-Z',
  ])('preserves ordinary confidentiality through exactly one supplier layer: %s', (body) => {
    expect(redactTextForOutbound(body)).not.toContain('SYNTHETIC_CANARY');
    const content = `Data: ${JSON.stringify(body)}`;
    const row = agentMessageSchema.parse({
      ...ordinary(),
      role: 'user',
      kind: 'record_prompt',
      content,
      ...recordContextMetadata(),
    });
    const projected = projectCanonicalConversationRow(row, identityProjector);
    expect(projected.content).not.toContain('SYNTHETIC_CANARY');
    expect(projected.content).toContain('FINAL-SAFE-Z');
    expect(() => JSON.parse(projected.content.slice('Data: '.length))).not.toThrow(
      projected.content,
    );
    expect(row.content).toBe(content);
    expect(foldHistoricalConversationRows([row])[0]!.content).toBe(projected.content);
  });

  it('keeps safe encoded bytes, literal backslash-n and exemptions without global decoding', () => {
    for (const body of [
      String.raw`Notes\napi_key: ordinary-example`,
      'api_key: "${NAME} ${OTHER}"\nFINAL-SAFE-Z',
      '{"api_key":"${NAME} ${OTHER}"}',
      'Safe "quotes" \\ path {{recordSelection}} {{> never-expand}}',
    ]) {
      const content = `Data: ${JSON.stringify(body)}`;
      const row = agentMessageSchema.parse({
        ...ordinary(),
        role: 'user',
        kind: 'record_prompt',
        content,
        ...recordContextMetadata(),
      });
      expect(projectCanonicalConversationRow(row, identityProjector).content).toBe(content);
    }
    const content = JSON.stringify('Notes\napi_key: SYNTHETIC_CANARY\nFINAL-SAFE-Z');
    expect(
      projectCanonicalConversationRow({ ...ordinary(), content }, identityProjector).content,
    ).toContain('SYNTHETIC_CANARY');
  });

  it('filters local descriptor string leaves while keeping safe identities and malformed surrounding prose as text', () => {
    const descriptor = {
      current: {
        card_id: 'project',
        entry_id: source,
        locator: 'record:///status.md?card=project&v=1',
        note: 'Notes\napi_key: SYNTHETIC_CANARY\nFINAL-SAFE-Z',
      },
      prior: null,
      reason: 'initial',
    };
    const content = `Unmatched prose " and invalid JSON {\nSelection: ${JSON.stringify(descriptor)}\nPlain api_key=prose-canary FINAL-PROSE-Z`;
    const row = agentMessageSchema.parse({
      ...ordinary(),
      role: 'user',
      kind: 'record_prompt',
      content,
      ...recordContextMetadata(),
    });
    const projected = projectCanonicalConversationRow(row, identityProjector);
    expect(projected.content).not.toMatch(/SYNTHETIC_CANARY|prose-canary/);
    expect(projected.content).toContain('Unmatched prose " and invalid JSON {');
    expect(projected.content).toContain('FINAL-PROSE-Z');
    const publicDescriptor = JSON.parse(
      projected.content.split('\n')[1]!.slice('Selection: '.length),
    );
    expect(publicDescriptor.current).toMatchObject({
      card_id: 'project',
      entry_id: source,
      locator: descriptor.current.locator,
      note: 'Notes\napi_key: [REDACTED]\nFINAL-SAFE-Z',
    });
    expect(row.content).toBe(content);
  });
  it('keeps tool-owned safe URL projection while independently redacting embedded and row call identity metadata', () => {
    const callId = 'token=identity-canary';
    const row = agentMessageSchema.parse({ ...call(), id: `${source}:tool-call:${callId}`, tool_call_id: callId,
      content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: callId, type: 'function', function: { name: 'webfetch', arguments: JSON.stringify({ url: OUTBOUND_URL }) } }] }),
    });
    const projected = projectCanonicalConversationRow(row, projectToolInvocation);
    const embedded = JSON.parse(projected.content).tool_calls[0];
    expect(JSON.parse(embedded.function.arguments).url).toBe(OUTBOUND_REDACTED_URL);
    expect(embedded.id).toBe(projected.tool_call_id);
    expect(projected.tool_call_id).toBe('token=[REDACTED]');
    expect(JSON.stringify(projected)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(projected)).not.toContain('identity-canary');
  });
  it('projects record prompt text and source metadata independently without exposing internal selection or policy hashes', () => {
    const reference = 'token=metadata-canary';
    const row = agentMessageSchema.parse({ ...ordinary(), role: 'user', kind: 'record_prompt',
      content: 'Actual rendered instruction token=text-canary FINAL-Z', instruction_origin: 'workflow_prompt',
      record_prompt: { reference, node_id: 'execute', reason: 'initial' },
      context_policy: { ...TEXT_ROW_POLICY, compactable: false, compaction_key: 'token=key-canary' },
      record_observations: [{ observed: { card_id: 'project', record_name: 'status.md', view: 'effective', selection_kind: 'current', head: { head_id: source, revision: 3 }, selection: { kind: 'draft', content_sha256: 'a'.repeat(64), accepted_backing: { kind: 'accepted', entry_id: source, version: 1, locator: 'record:///status.md?card=project&v=1', content_sha256: 'b'.repeat(64) } }, exposure: { kind: 'full_body' } }, source: { kind: 'prompt', input_id: source, node_id: 'execute', reference } }],
    });
    const before = structuredClone(row);
    const publicRow = projectCanonicalConversationRow(row, identityProjector);
    expect(publicRow.content).toBe('Actual rendered instruction token=[REDACTED] FINAL-Z');
    expect(publicRow.record_observations![0]!.source).toMatchObject({ reference: 'token=[REDACTED]' });
    expect(publicRow.record_observations![0]!.observed.selection).toEqual({ kind: 'draft', accepted_backing: { kind: 'accepted', entry_id: source, version: 1, locator: 'record:///status.md?card=project&v=1' } });
    for (const hidden of ['canary', 'content_sha256', 'a'.repeat(64), 'b'.repeat(64)]) expect(JSON.stringify(publicRow)).not.toContain(hidden);
    expect(row).toEqual(before);
    expect(() => AgentConversationEntrySchema.parse({ ...publicRow, record_observations: row.record_observations })).toThrow();
  });
  it('positively projects separate role/node instruction strings and rejects private nested fields', () => {
    const payload = {
      event: 'activation_open', agent_name: 'planner', card_id: 'project', input_id: source, timestamp,
      instructions: {kind: 'prepared',activation_id:'11111111-1111-4111-8111-111111111111',caller:{kind:'root'},card:{cardId:'project',cardType:'project',title:'token=tok_secret'},parent_direction:null, role_text: 'ROLE-SENTINEL token=tok_secret', node: {node_id:'plan',text:'NODE-SENTINEL token=tok_secret'}},
    };
    const marker = { ...ordinary(), role:'system', kind:'activity', context_policy:STRUCTURAL_ROW_POLICY.activation_boundary, content:JSON.stringify(payload) };
    const projected = projectCanonicalConversationRow(marker, identityProjector);
    const parsed = parseActivationOpenPayload(projected.content, sessionId, timestamp)!;
    expect(parsed.instructions).toEqual({kind:'prepared',activation_id:'11111111-1111-4111-8111-111111111111',caller:{kind:'root'},card:{cardId:'project',cardType:'project',title:'token=[REDACTED]'},parent_direction:null,role_text:'ROLE-SENTINEL token=[REDACTED]',node:{node_id:'plan',text:'NODE-SENTINEL token=[REDACTED]'}});
    expect(JSON.stringify(projected)).not.toContain('tok_secret');
    expect(projected).not.toHaveProperty('model_spec');
    for (const instructions of [
      {...payload.instructions, immutablePrefixBytes:'PRIVATE-PREFIX'},
      {...payload.instructions, node:{...payload.instructions.node, native:'PRIVATE-NATIVE'}},
    ]) expect(() => projectCanonicalConversationRow({...marker,content:JSON.stringify({...payload,instructions})},identityProjector)).toThrow();
    expect(() => projectCanonicalConversationRow({...marker,content:JSON.stringify({...payload,diagnostic_body:'PRIVATE-DIAGNOSTIC'})},identityProjector)).toThrow();
    expect(parseActivationOpenPayload(marker.content, sessionId, timestamp)?.instructions).toEqual(payload.instructions);
  });

  it('accepts only positive card-owned workflow provenance and preserves it without inferring unmarked history', () => {
    const row = {...ordinary(), role:'user', instruction_origin:'workflow_prompt'};
    expect(projectCanonicalConversationRow(row,identityProjector).instruction_origin).toBe('workflow_prompt');
    expect(projectCanonicalConversationRow({...ordinary(),role:'user'},identityProjector).instruction_origin).toBeUndefined();
    for (const override of [
      {instruction_origin:'human'}, {role:'assistant'}, {session_id:'agent:analyst:global'},
      {kind:'activity',role:'system',context_policy:STRUCTURAL_ROW_POLICY.activation_boundary},
    ]) expect(() => agentMessageSchema.parse({...row,...override})).toThrow();
  });
  it('folds historical rows through tool-specific projection without private rows, reordering, or source mutation', () => {
    const privateBundle = responsesBundle(sessionId, source, RESPONSES_A, '{"success":true,"data":null}');
    const rows = [privateBundle[0]!, call(), ordinary(), result()];
    rows[1] = { ...rows[1]!, provider_projection: privateBundle[1]!.provider_projection };
    const stored = structuredClone(rows);
    const projected = foldHistoricalConversationRows(rows);
    expect(projected.map(({ id, timestamp, round_id, message_index, block_index }) => ({ id, timestamp, round_id, message_index, block_index })))
      .toEqual(rows.slice(1).map(({ id, timestamp, round_id, message_index, block_index }) => ({ id, timestamp, round_id, message_index, block_index })));
    const serialized = JSON.stringify(projected);
    for (const excluded of ['tok_secret', 'private-model', 'private-requested-model', 'producer_account_id', 'ciphertext-', 'provider_projection']) {
      expect(serialized).not.toContain(excluded);
    }
    const argumentsJson = JSON.parse(projected[0]!.content).tool_calls[0].function.arguments;
    expect(JSON.parse(argumentsJson).url).toBe('https://example.test/?[REDACTED]');
    expect(JSON.parse(projected[2]!.content)).toMatchObject({ success: false, error: 'failed tok-[REDACTED]' });
    expect(projected[2]!.context_policy).toEqual({ kind: 'tool_result', settlement_origin: 'executed' });
    expect(rows).toEqual(stored);
  });

  it('rejects malformed historical embedded tool content rather than returning it unprojected', () => {
    expect(() => foldHistoricalConversationRows([{ ...call(), content: '{' }])).toThrow('malformed embedded content');
    expect(() => foldHistoricalConversationRows([{ ...result(), content: '{' }])).toThrow(/tool_result/);
  });

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

  it('preserves the current settled webfetch text shape through canonical historical projection', () => {
    const content = JSON.stringify({ success: true, data: { kind: 'text', redacted_url: 'https://example.test/path?[REDACTED]', status: 200, headers: {}, head: 'safe head', head_utf8_bytes: 9, redacted_text_utf8_bytes: 20, fetched_text_utf8_bytes: 30, head_complete: false, fetch_truncated: true, content_url: 'work:///tmp/stash/webfetch-1-0123456789abcdef.txt' } });
    const projected = projectCanonicalConversationRow(resultFor('webfetch', content), projectToolInvocation);
    expect(JSON.parse(projected.content)).toEqual(JSON.parse(content));
  });

  it('projects historical search arrays, plaintext JsonSlice, and current hex JsonSlice opaquely without mutating stored bytes', () => {
    for (const fixture of historicalOpaqueToolResults.filter(({ toolName }) => toolName === 'glob' || toolName === 'grep')) {
      const content = JSON.stringify(fixture.result);
      const row = resultFor(fixture.toolName, content);
      const storedPolicy = structuredClone(row.context_policy);
      const projected = projectCanonicalConversationRow(row, projectToolInvocation);
      const body = JSON.parse(projected.content);
      expect(row.content).toBe(content);
      expect(row.context_policy).toEqual(storedPolicy);
      expect(JSON.stringify(body)).not.toContain('historical-secret');
      const originalHex = content.match(/"content_hex":"([0-9a-f]+)"/u)?.[1];
      const projectedHex = projected.content.match(/"content_hex":"([0-9a-f]+)"/u)?.[1];
      expect(projectedHex).toBe(originalHex);
      if (content.includes('"content"')) expect(projected.content).toContain('"content"');
      if (content.includes('"matches":[')) expect(Array.isArray(body.data.matches)).toBe(true);
    }
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
    ).toThrow(/tool_result/);
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

function recordContextMetadata() {
  return {
    instruction_origin: 'workflow_prompt',
    record_prompt: { reference: 'changed-record-with-body', node_id: 'plan', reason: 'initial' },
    record_observations: [{ observed: { card_id: 'project', record_name: 'status.md', view: 'effective', selection_kind: 'current', head: { head_id: source, revision: 1 }, selection: { kind: 'accepted', entry_id: source, version: 1, locator: 'record:///status.md?card=project&v=1', content_sha256: 'a'.repeat(64) }, exposure: { kind: 'full_body' } }, source: { kind: 'prompt', input_id: source, node_id: 'plan', reference: 'changed-record-with-body' } }],
  };
}

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
    context_policy: toolRowPolicies({ content: '' }).call,
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
    context_policy: toolRowPolicies({ content: JSON.stringify({
      success: false,
      error: 'failed tok_secret',
      data: { historical_wrapper: ['unchanged'] },
    }) }).result,
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

function resultFor(tool: string, content: string): AgentMessage {
  const policies = toolRowPolicies({ content });
  return {
    ...result(),
    id: `${source}:tool-result:call-a`,
    tool,
    content,
    context_policy: policies.result,
  };
}

function ordinary(): AgentMessage {
  return {
    id: 'ordinary-row',
    session_id: sessionId,
    role: 'assistant',
    kind: 'text',
    context_policy: TEXT_ROW_POLICY,
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

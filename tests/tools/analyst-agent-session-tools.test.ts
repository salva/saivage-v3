import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { ACTIVITY_ROW_POLICY, TEXT_ROW_POLICY, toolRowPolicies } from '../helpers/row-policy-fixtures.js';
import {
  ListAgentSessionsToolDataSchema,
  ReadAgentSessionToolDataSchema,
  analystMiscToolBinders,
  list_agent_sessions,
  read_agent_session,
} from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { executingLlmSnapshots } from '../helpers/executing-llm-snapshot.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { CardService } from '../helpers/canonical-project.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import {
  OUTBOUND_RAW_MARKER,
  OUTBOUND_REDACTED_URL,
  OUTBOUND_URL,
} from '../helpers/outbound-identity-fixtures.js';
import { publishThreeGenerationCompactedConversation } from '../helpers/compacted-conversation-fixture.js';

const roots: string[] = [];
const timestamp = '2026-07-18T00:00:00.000Z';
const sourceInputId = '11111111-1111-4111-8111-111111111111';
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-agent-tool-'));
  roots.push(root);
  initProjectTree(root);
  return root;
}
function context(projectRoot: string): ToolContext {
  return { projectRoot, store: new CardService(projectRoot), captureExecutingLlmSnapshots: () => executingLlmSnapshots(['agent:planner:project']) } as unknown as ToolContext;
}
function rows(): AgentMessage[] {
  return [
    {
      id: 'activation',
      session_id: 'agent:planner:project',
      role: 'system',
      kind: 'activity',
      context_policy: ACTIVITY_ROW_POLICY,
      content: JSON.stringify({
        event: 'activation_open',
        agent_name: 'planner',
        card_id: 'project',
        input_id: sourceInputId,
        timestamp,
      }),
      round_id: `r-pre-${sourceInputId.replaceAll('-', '')}`,
      message_index: 0,
      block_index: 0,
      timestamp,
    },
    {
      id: 'first',
      session_id: 'agent:planner:project',
      role: 'user',
      kind: 'text',
      context_policy: TEXT_ROW_POLICY,
      content: 'first',
      round_id: `r-user-${sourceInputId.replaceAll('-', '')}`,
      message_index: 1,
      block_index: 0,
      timestamp,
    },
    {
      id: `${sourceInputId}:tool-call:call-1`,
      session_id: 'agent:planner:project',
      role: 'assistant',
      kind: 'tool_call',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '' }).call,
      content: JSON.stringify({
        role: 'assistant',
        tool_calls: [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'webfetch', arguments: JSON.stringify({ url: OUTBOUND_URL }) },
          },
        ],
      }),
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    },
  ];
}

describe('Analyst agent-session tools', () => {
  it('returns a strict compacted current session through the production binder and executor', async () => {
    const projectRoot = setup();
    const sessionId = await publishThreeGenerationCompactedConversation(projectRoot);
    const binder = analystMiscToolBinders.find((candidate) => candidate.name === 'read_agent_session');
    if (!binder) throw new Error('Expected production read_agent_session binder.');
    const bound = binder.bind(context(projectRoot));
    const args = bound.inputSchema.parse({ session_id: sessionId });
    const execution = await bound.executor(args, new AbortController().signal);

    expect(execution.evidence).toEqual({ kind: 'observational_result_bytes' });
    expect(execution.providerOutcome.kind).toBe('succeeded');
    if (execution.providerOutcome.kind !== 'succeeded')
      throw new Error(execution.providerOutcome.error);
    const data = ReadAgentSessionToolDataSchema.parse(execution.providerOutcome.data);
    expect(Object.keys(data).sort()).toEqual([
      'messages',
      'ownership',
      'returned_visible_entries',
      'segment_context',
      'segment_version',
      'session',
      'total_visible_entries',
    ]);
    expect(data.segment_version).toBe(3);
    expect(data.segment_context).not.toBeNull();
    const segmentContext = data.segment_context;
    if (segmentContext === null) throw new Error('Expected compacted segment context.');
    expect(Object.keys(segmentContext).sort()).toEqual([
      'continuation',
      'coverage',
      'covered_group_count',
      'covered_through_message_id',
      'dispositions',
      'kind',
      'prior_genesis_id',
      'prior_history_hash',
      'required_model_facts',
      'source_kind',
      'source_version',
      'summary_text',
    ]);
    expect(Object.keys(segmentContext.dispositions).sort()).toEqual([
      'count',
      'evidence_only',
      'sha256',
      'summarized',
      'superseded',
    ]);
    expect(segmentContext.dispositions).not.toHaveProperty('evidenceOnly');
    expect(Object.keys(segmentContext.coverage).sort()).toEqual([
      'accumulated_summary_sha256',
      'covered_source_groups_sha256',
      'covered_through_message_id',
      'source_session_id',
      'source_version',
    ]);
    for (const domainKey of [
      'accumulatedSummarySha256',
      'coveredSourceGroupsSha256',
      'coveredThroughMessageId',
      'sourceSessionId',
      'sourceVersion',
    ]) expect(segmentContext.coverage).not.toHaveProperty(domainKey);
    expect(Object.keys(segmentContext.required_model_facts).sort()).toEqual([
      'latestContentPolicyRefusal',
      'latestRecovery',
    ]);
    expect(segmentContext.required_model_facts.latestRecovery).not.toBeNull();
    expect(Object.keys(segmentContext.required_model_facts.latestRecovery!).sort()).toEqual([
      'activationInputId',
      'sourceMessageId',
    ]);
    expect(segmentContext.required_model_facts.latestContentPolicyRefusal).not.toBeNull();
    expect(Object.keys(segmentContext.required_model_facts.latestContentPolicyRefusal!).sort()).toEqual([
      'activationInputId',
      'markerId',
    ]);
    expect(segmentContext.source_kind).toBe('prior_genesis_plus_current_rows');
    expect(segmentContext.prior_genesis_id).not.toBeNull();
    expect(segmentContext.prior_history_hash).not.toBeNull();
    expect(segmentContext.continuation.kind).toBe('inherited_open_round');
    if (segmentContext.continuation.kind !== 'inherited_open_round')
      throw new Error('Expected inherited open-round continuation.');
    expect(Object.keys(segmentContext.continuation).sort()).toEqual([
      'activation',
      'active_segment_kind',
      'kind',
    ]);
    expect(Object.keys(segmentContext.continuation.activation).sort()).toEqual(['input_id', 'marker_id']);
    expect(segmentContext.continuation.activation).not.toHaveProperty('inputId');
    expect(segmentContext.continuation.activation).not.toHaveProperty('markerId');
  });

  it('returns the exact direct and nested durable call-only tail', async () => {
    const projectRoot = setup();
    appendConversationBatch({ projectRoot }, rows());
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS, () => executingLlmSnapshots(['agent:planner:project']));
    const expected = service.getConversation('agent:planner:project');
    const detail = service.getSession('agent:planner:project');
    const result = await read_agent_session(context(projectRoot), {
      session_id: 'agent:planner:project',
      last_n: 1,
    });
    expect(result).toEqual({
      kind: 'succeeded',
      data: {
        session: detail.session,
        ownership: 'active',
        segment_version: 1,
        segment_context: null,
        total_visible_entries: 3,
        returned_visible_entries: 1,
        messages: [expected.entries[2]],
      },
    });
    if (result.kind !== 'succeeded') throw new Error(result.error);
    const parsedResult = { data: ReadAgentSessionToolDataSchema.parse(result.data) };
    expect(parsedResult.data.session).toEqual(expect.objectContaining({ status: 'active', activity: 'busy' }));
    expect(JSON.stringify(result)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(result)).toContain(OUTBOUND_REDACTED_URL);
    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: {
        sessionId: 'agent:analyst:global',
        sourceInputId: '22222222-2222-4222-8222-222222222222',
        toolCallId: 'nested-durable',
        toolName: 'read_agent_session',
      },
      result: { success: true, data: result.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success)
      throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toMatchObject({
      total_visible_entries: 3,
      returned_visible_entries: 1,
      messages: [{ id: rows()[2]!.id, kind: 'tool_call' }],
    });
    expect(JSON.stringify(nested.result.data)).not.toContain(OUTBOUND_RAW_MARKER);
  });

  it('preserves an exact result-only tail and reprojects it identically when nested historically', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: 'agent:planner:project',
      role: 'tool',
      kind: 'tool_result',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '{"success":false,"error":"failed token=synthetic-result-secret"}' }).result,
      content: '{"success":false,"error":"failed token=synthetic-result-secret"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const direct = await read_agent_session(context(projectRoot), {
      session_id: 'agent:planner:project',
      last_n: 1,
    });
    expect(direct).toMatchObject({ kind: 'succeeded', data: { total_visible_entries: 4, returned_visible_entries: 1 } });
    if (direct.kind !== 'succeeded') throw new Error(direct.error);
    expect((direct.data as { messages: AgentMessage[] }).messages[0]!.kind).toBe('tool_result');
    expect(JSON.stringify(direct)).not.toContain('synthetic-result-secret');

    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: {
        sessionId: 'agent:analyst:global',
        sourceInputId: '22222222-2222-4222-8222-222222222222',
        toolCallId: 'nested-read',
        toolName: 'read_agent_session',
      },
      result: { success: true, data: direct.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success)
      throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toMatchObject({
      total_visible_entries: 4,
      returned_visible_entries: 1,
      messages: [{ kind: 'tool_result' }],
    });
    const nestedMessage = (nested.result.data as { messages: AgentMessage[] }).messages[0]!;
    expect(() => JSON.parse(nestedMessage.content)).not.toThrow();
    expect(nestedMessage.content).not.toContain('synthetic-result-secret');
  });

  it('keeps complete-pair tail boundaries, totals, ordering, and parse counts exact', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({
      id: `${sourceInputId}:tool-result:call-1`,
      session_id: 'agent:planner:project',
      role: 'tool',
      kind: 'tool_result',
      tool: 'webfetch',
      tool_call_id: 'call-1',
      context_policy: toolRowPolicies({ content: '{"success":false,"error":"settled"}' }).result,
      content: '{"success":false,"error":"settled"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const projected = await read_agent_session(context(projectRoot), {
      session_id: 'agent:planner:project',
      last_n: 2,
    });
    expect(projected).toMatchObject({
      kind: 'succeeded',
      data: {
        total_visible_entries: 4,
        returned_visible_entries: 2,
        messages: [{ kind: 'tool_call' }, { kind: 'tool_result' }],
      },
    });
  });

  it('fails noncanonical and absent exact identities without synthesizing a session', async () => {
    const projectRoot = setup();
    const toolContext = context(projectRoot);
    await expect(
      read_agent_session(toolContext, { session_id: 'planner:not_valid' as never }),
    ).rejects.toThrow();
    await expect(
      read_agent_session(toolContext, { session_id: 'agent:planner:project' }),
    ).resolves.toMatchObject({
      kind: 'failed',
      error: 'Agent session has no current conversation segment.',
      data: { code: 'agent_session_empty', session_id: 'agent:planner:project' },
    });
  });

  it('uses authoritative inventory for listing while retaining direct tombstoned history', async () => {
    const projectRoot = setup();
    const cards = new CardService(projectRoot);
    const child = cards.create({
      type: 'code',
      parent: 'project',
      title: 'child',
      bootstrap_content: 'brief',
      tags: [],
      priority: 0,
      urgency: 'normal',
      created_by: 'analyst',
      depends_on: [],
      related: [],
    });
    const sessionId = `agent:executor:${child.id}` as const;
    appendConversationBatch({ projectRoot }, [
      {
        ...rows()[0]!,
        id: 'child-activation',
        session_id: sessionId,
        content: JSON.stringify({
          event: 'activation_open',
          agent_name: 'executor',
          card_id: child.id,
          input_id: sourceInputId,
          timestamp,
        }),
      },
    ]);
    const toolContext = context(projectRoot);
    await expect(list_agent_sessions(toolContext, {})).resolves.toMatchObject({
      kind: 'succeeded',
      data: { sessions: [expect.objectContaining({ id: sessionId })] },
    });
    cards.deleteSubtrees([child.id], () => true);
    await expect(list_agent_sessions(toolContext, {})).resolves.toEqual({
      kind: 'succeeded',
      data: { sessions: [] },
    });
    await expect(read_agent_session(toolContext, { session_id: sessionId })).resolves.toMatchObject({
      kind: 'succeeded',
      data: { session: { id: sessionId } },
    });
  });

  it('rejects former producer success and safe-data failure shapes', () => {
    expect(ListAgentSessionsToolDataSchema.safeParse([]).success).toBe(
      false,
    );
    expect(
      ReadAgentSessionToolDataSchema.safeParse({
        success: false,
        error: 'missing',
        data: { safe: true },
      }).success,
    ).toBe(false);
    expect(
      ReadAgentSessionToolDataSchema.safeParse({
        success: true,
        data: {
          session: {},
          activity_status: {},
          total_visible_entries: 0,
          returned_visible_entries: 0,
          parse_errors: 0,
          messages: [],
        },
      }).success,
    ).toBe(false);
  });
});

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import {
  ListAgentSessionsToolResultSchema,
  ReadAgentSessionToolResultSchema,
  list_agent_sessions,
  read_agent_session,
} from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { initProjectTree, TEST_WORKFLOWS } from '../helpers/canonical-project.js';
import { CardService } from '../helpers/canonical-project.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';
import {
  OUTBOUND_RAW_MARKER,
  OUTBOUND_REDACTED_URL,
  OUTBOUND_URL,
} from '../helpers/outbound-identity-fixtures.js';

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
  return { projectRoot, store: new CardService(projectRoot) } as unknown as ToolContext;
}
function rows(): AgentMessage[] {
  return [
    {
      id: 'activation',
      session_id: 'agent:planner:project',
      role: 'system',
      kind: 'activity',
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
  it('returns the exact direct and nested durable call-only tail', async () => {
    const projectRoot = setup();
    appendConversationBatch({ projectRoot }, rows());
    const service = new AgentOperatorReadModelService(projectRoot, TEST_WORKFLOWS);
    const expected = service.getConversation('agent:planner:project');
    const detail = service.getSession('agent:planner:project');
    const result = await read_agent_session(context(projectRoot), {
      sessionId: 'agent:planner:project',
      lastN: 1,
    });
    expect(result).toEqual({
      success: true,
      data: {
        session: detail.session,
        total_messages: 3,
        returned: 1,
        messages: [expected.entries[2]],
      },
    });
    expect(JSON.stringify(result)).not.toContain(OUTBOUND_RAW_MARKER);
    expect(JSON.stringify(result)).toContain(OUTBOUND_REDACTED_URL);
    if (!result.success) throw new Error(result.error);
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
      total_messages: 3,
      returned: 1,
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
      content: '{"success":false,"error":"failed token=synthetic-result-secret"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const direct = await read_agent_session(context(projectRoot), {
      sessionId: 'agent:planner:project',
      lastN: 1,
    });
    expect(direct).toMatchObject({ success: true, data: { total_messages: 4, returned: 1 } });
    if (!direct.success) throw new Error(direct.error);
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
      total_messages: 4,
      returned: 1,
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
      content: '{"success":false,"error":"settled"}',
      round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`,
      message_index: 2,
      block_index: 0,
      timestamp,
    });
    appendConversationBatch({ projectRoot }, complete);
    const projected = await read_agent_session(context(projectRoot), {
      sessionId: 'agent:planner:project',
      lastN: 2,
    });
    expect(projected).toMatchObject({
      success: true,
      data: {
        total_messages: 4,
        returned: 2,
        messages: [{ kind: 'tool_call' }, { kind: 'tool_result' }],
      },
    });
  });

  it('fails noncanonical and absent exact identities without synthesizing a session', async () => {
    const projectRoot = setup();
    const toolContext = context(projectRoot);
    await expect(
      read_agent_session(toolContext, { sessionId: 'planner:not_valid' }),
    ).resolves.toMatchObject({ success: false, error: 'sessionId is not canonical.' });
    await expect(
      read_agent_session(toolContext, { sessionId: 'agent:planner:project' }),
    ).resolves.toMatchObject({
      success: false,
      error: "Agent session 'agent:planner:project' was not found.",
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
      success: true,
      data: { sessions: [expect.objectContaining({ id: sessionId })] },
    });
    cards.deleteSubtrees([child.id], () => true);
    await expect(list_agent_sessions(toolContext, {})).resolves.toEqual({
      success: true,
      data: { sessions: [] },
    });
    await expect(read_agent_session(toolContext, { sessionId })).resolves.toMatchObject({
      success: true,
      data: { session: { id: sessionId } },
    });
  });

  it('rejects former producer success and safe-data failure shapes', () => {
    expect(ListAgentSessionsToolResultSchema.safeParse({ success: true, data: [] }).success).toBe(
      false,
    );
    expect(
      ReadAgentSessionToolResultSchema.safeParse({
        success: false,
        error: 'missing',
        data: { safe: true },
      }).success,
    ).toBe(false);
    expect(
      ReadAgentSessionToolResultSchema.safeParse({
        success: true,
        data: {
          session: {},
          activity_status: {},
          total_messages: 0,
          returned: 0,
          parse_errors: 0,
          messages: [],
        },
      }).success,
    ).toBe(false);
  });
});

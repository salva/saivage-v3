import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { appendAppLogEntry } from '../../src/persistence/app-log.js';
import type { ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { list_agent_sessions, read_agent_session } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';
import { projectToolInvocation } from '../../src/tools/tool-invocation-outbound.js';

const roots: string[] = [];
const timestamp = '2026-07-18T00:00:00.000Z';
const sourceInputId = '11111111-1111-4111-8111-111111111111';
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-agent-tool-')); roots.push(root); initProjectTree(root); return root; }
function rows(): AgentMessage[] {
  return [
    { id: 'first', session_id: 'planner:project', role: 'user', kind: 'text', content: 'first', round_id: `r-user-${sourceInputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp },
    { id: `${sourceInputId}:tool-call:call-1`, session_id: 'planner:project', role: 'assistant', kind: 'tool_call', tool: 'webfetch', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://tok_primary.example/path?token=synthetic-query-secret"}' } }] }), round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`, message_index: 1, block_index: 0, timestamp },
  ];
}
function waiting(): ExecutingLlmSnapshot { return { sessionId: 'planner:project', agentId: 'planner:project', role: 'planner', cardId: 'project', activity: { mode: 'waiting', barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId, toolCallId: 'call-1', toolName: 'webfetch' } } }; }

describe('Analyst agent-session tools', () => {
  it.each(['active', 'waiting'] as const)('returns the exact direct and nested %s call-only tail', async (status) => {
    const projectRoot = setup();
    appendConversationBatch({ projectRoot }, rows());
    const snapshots = () => [status === 'waiting' ? waiting() : { ...waiting(), activity: { mode: 'active' as const, barrier: null } }];
    const expected = new AgentOperatorReadModelService(projectRoot, snapshots).getConversation('planner:project');
    if (expected.statusCode === 400 || expected.statusCode === 404) throw new Error(expected.body.error);
    if (!('session' in expected.body)) throw new Error('expected conversation');
    const result = await read_agent_session({ projectRoot, captureExecutingLlmSnapshots: snapshots } as unknown as ToolContext, { sessionId: 'planner:project', lastN: 1 });
    expect(result).toEqual({ success: true, data: { session: expected.body.session, activity_status: expected.body.activity_status, total_messages: 2, returned: 1, parse_errors: 0, messages: [expected.body.entries[1]] } });
    expect(JSON.stringify(result)).not.toContain('synthetic-query-secret');
    expect(JSON.stringify(result)).toContain('https://tok_primary.example/path?[REDACTED]');
    if (!result.success) throw new Error(result.error);
    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: { sessionId: 'analyst:global', sourceInputId: '22222222-2222-4222-8222-222222222222', toolCallId: `nested-${status}`, toolName: 'read_agent_session' },
      result: { success: true, data: result.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success) throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toEqual(result.data);
  });

  it('preserves an exact result-only tail and reprojects it identically when nested historically', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({ id: `${sourceInputId}:tool-result:call-1`, session_id: 'planner:project', role: 'tool', kind: 'tool_result', tool: 'webfetch', tool_call_id: 'call-1', content: '{"success":false,"error":"failed token=synthetic-result-secret"}', round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`, message_index: 2, block_index: 0, timestamp });
    appendConversationBatch({ projectRoot }, complete);
    const direct = await read_agent_session({ projectRoot, captureExecutingLlmSnapshots: () => [] } as unknown as ToolContext, { sessionId: 'planner:project', lastN: 1 });
    expect(direct).toMatchObject({ success: true, data: { activity_status: { status: 'inactive', pending_calls: [] }, total_messages: 3, returned: 1, parse_errors: 0 } });
    if (!direct.success) throw new Error(direct.error);
    expect((direct.data as { messages: AgentMessage[] }).messages[0]!.kind).toBe('tool_result');
    expect(JSON.stringify(direct)).not.toContain('synthetic-result-secret');

    const nested = projectToolInvocation({
      shape: 'result-row',
      identity: { sessionId: 'analyst:global', sourceInputId: '22222222-2222-4222-8222-222222222222', toolCallId: 'nested-read', toolName: 'read_agent_session' },
      result: { success: true, data: direct.data },
    });
    if (nested.shape !== 'result-row' || !nested.result.success) throw new Error('Expected nested successful read_agent_session result.');
    expect(nested.result.data).toEqual(direct.data);
  });

  it('keeps complete-pair tail boundaries, totals, ordering, and parse counts exact', async () => {
    const projectRoot = setup();
    const complete = rows();
    complete.push({ id: `${sourceInputId}:tool-result:call-1`, session_id: 'planner:project', role: 'tool', kind: 'tool_result', tool: 'webfetch', tool_call_id: 'call-1', content: '{"success":false,"error":"settled"}', round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`, message_index: 2, block_index: 0, timestamp });
    appendConversationBatch({ projectRoot }, complete);
    const projected = await read_agent_session({ projectRoot, captureExecutingLlmSnapshots: () => [] } as unknown as ToolContext, { sessionId: 'planner:project', lastN: 2 });
    expect(projected).toMatchObject({ success: true, data: { total_messages: 3, returned: 2, parse_errors: 0, messages: [{ kind: 'tool_call' }, { kind: 'tool_result' }] } });
  });

  it('fails noncanonical and absent exact identities without synthesizing a session', async () => {
    const projectRoot = setup();
    const context = { projectRoot, captureExecutingLlmSnapshots: () => [] } as unknown as ToolContext;
    await expect(read_agent_session(context, { sessionId: 'planner:not_valid' })).resolves.toMatchObject({ success: false, error: 'sessionId is not canonical.' });
    await expect(read_agent_session(context, { sessionId: 'planner:project' })).resolves.toMatchObject({ success: false, error: "Agent session 'planner:project' was not found." });
  });

  it('uses aggregate inventory for listing while retaining direct tombstoned history', async () => {
    const projectRoot = setup();
    const cards = new CardService(projectRoot);
    const child = cards.create({ type: 'code', parent: 'project', title: 'child', brief: 'brief', tags: [], priority: 0, urgency: 'normal', created_by: 'analyst', depends_on: [], related: [] });
    const sessionId = `executor:${child.id}` as const;
    appendConversationBatch({ projectRoot }, [{ ...rows()[0]!, id: 'child-text', session_id: sessionId }]);
    appendAppLogEntry(projectRoot, 'provider_exchange', () => providerExchange(sessionId, 'tool-shared-model'));
    const context = { projectRoot, captureExecutingLlmSnapshots: () => [] } as unknown as ToolContext;
    await expect(list_agent_sessions(context, {})).resolves.toMatchObject({ success: true, data: [expect.objectContaining({ id: sessionId, model: 'tool-shared-model' })] });
    cards.deleteSubtrees([child.id], () => true);
    await expect(list_agent_sessions(context, {})).resolves.toEqual({ success: true, data: [] });
    await expect(read_agent_session(context, { sessionId })).resolves.toMatchObject({ success: true, data: { session: { id: sessionId, status: 'inactive' }, activity_status: { status: 'inactive', pending_calls: [] } } });
  });

  it('fails aggregate tool listing when a live snapshot has no inventory row', async () => {
    const projectRoot = setup();
    const missing: ExecutingLlmSnapshot = { sessionId: 'executor:card-a', agentId: 'executor:card-a', role: 'executor', cardId: 'card-a', activity: { mode: 'active', barrier: null } };
    const result = await list_agent_sessions({ projectRoot, captureExecutingLlmSnapshots: () => [missing] } as unknown as ToolContext, {});
    expect(result).toMatchObject({ success: false, error: expect.stringContaining("has no aggregate conversation row") });
  });
});

function providerExchange(sessionId: string, model: string) {
  const sourceInputId = `${sessionId}-input`;
  return {
    type: 'provider_exchange' as const,
    data: {
      session_id: sessionId, source_input_id: sourceInputId, attempt_index: 0, timestamp,
      payload: {
        contract_id: 'test.v1', contract_name: 'test', transport: 'generic' as const, provider: 'test', model,
        source_input_id: sourceInputId, attempt_index: 0, request_params: {}, started_at: timestamp,
        completed_at: timestamp, status: 'ok' as const, terminal_tool_fired: null, assistant_output_ids: [],
      },
    },
  };
}

import { afterEach, describe, expect, it } from '@jest/globals';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentOperatorReadModelService } from '../../src/application/read-models/agent-operator-read-model.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import type { ExecutingLlmSnapshot } from '../../src/runtime/actors/executing-llm-snapshot.js';
import type { AgentMessage } from '../../src/schemas/index.js';
import { list_agent_sessions, read_agent_session } from '../../src/tools/analyst-misc-tools.js';
import type { ToolContext } from '../../src/tools/analyst-tool-types.js';
import { initProjectTree } from '../helpers/canonical-project.js';
import { CardService } from '../../src/cards/card-service.js';

const roots: string[] = [];
const timestamp = '2026-07-18T00:00:00.000Z';
const sourceInputId = '11111111-1111-4111-8111-111111111111';
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

function setup() { const root = mkdtempSync(join(tmpdir(), 'saivage-analyst-agent-tool-')); roots.push(root); initProjectTree(root); return root; }
function rows(): AgentMessage[] {
  return [
    { id: 'first', session_id: 'planner:project', role: 'user', kind: 'text', content: 'first', round_id: `r-user-${sourceInputId.replaceAll('-', '')}`, message_index: 0, block_index: 0, timestamp },
    { id: `${sourceInputId}:tool-call:call-1`, session_id: 'planner:project', role: 'assistant', kind: 'tool_call', tool: 'webfetch', tool_call_id: 'call-1', content: JSON.stringify({ role: 'assistant', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'webfetch', arguments: '{"url":"https://example.com"}' } }] }), round_id: `r-assistant-${sourceInputId.replaceAll('-', '')}`, message_index: 1, block_index: 0, timestamp },
  ];
}
function waiting(): ExecutingLlmSnapshot { return { sessionId: 'planner:project', agentId: 'planner:project', role: 'planner', cardId: 'project', activity: { mode: 'waiting', barrier: { kind: 'external', sessionId: 'planner:project', sourceInputId, toolCallId: 'call-1', toolName: 'webfetch' } } }; }

describe('Analyst agent-session tools', () => {
  it('returns the exact direct session/activity projection and tails only messages', async () => {
    const projectRoot = setup();
    appendConversationBatch({ projectRoot }, rows());
    const snapshots = () => [waiting()];
    const expected = new AgentOperatorReadModelService(projectRoot, snapshots).getConversation('planner:project');
    if (expected.statusCode === 400 || expected.statusCode === 404) throw new Error(expected.body.error);
    if (!('session' in expected.body)) throw new Error('expected conversation');
    const result = await read_agent_session({ projectRoot, captureExecutingLlmSnapshots: snapshots } as unknown as ToolContext, { sessionId: 'planner:project', lastN: 1 });
    expect(result).toEqual({ success: true, data: { session: expected.body.session, activity_status: expected.body.activity_status, total_messages: 2, returned: 1, parse_errors: 0, messages: [expected.body.entries[1]] } });
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
    const context = { projectRoot, captureExecutingLlmSnapshots: () => [] } as unknown as ToolContext;
    await expect(list_agent_sessions(context, {})).resolves.toMatchObject({ success: true, data: [expect.objectContaining({ id: sessionId })] });
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

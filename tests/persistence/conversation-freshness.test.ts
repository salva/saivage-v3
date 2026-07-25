import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { initProjectTree } from '../helpers/canonical-project.js';
import { appendConversationBatch } from '../../src/persistence/conversation-file.js';
import { agentMessageSchema, type ConversationSessionId } from '../../src/schemas/index.js';
const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});
const stamp = '2026-07-24T00:00:00.000Z';
function row(session_id: ConversationSessionId, id: string, kind: 'activity' | 'text' = 'text') {
  const parts = session_id.split(':');
  const card = parts[2] === 'global' ? null : parts.slice(2).join(':');
  return agentMessageSchema.parse({
    id,
    session_id,
    role: kind === 'activity' ? 'system' : 'assistant',
    kind,
    content:
      kind === 'activity'
        ? JSON.stringify({
            agent_name: parts[1],
            event: 'activation_open',
            input_id: '00000000-0000-4000-8000-000000000001',
            timestamp: stamp,
            ...(card ? { card_id: card } : {}),
          })
        : 'message',
    round_id: `r-user-${'0'.repeat(32)}`,
    message_index: kind === 'activity' ? 0 : 1,
    block_index: 0,
    timestamp: stamp,
  });
}
describe('conversation publication freshness', () => {
  it('publishes the last physical ID and membership only on first publication', () => {
    const root = mkdtempSync(join(tmpdir(), 'conversation-freshness-'));
    roots.push(root);
    initProjectTree(root);
    const conversationChanged = jest.fn(),
      agentMembershipChanged = jest.fn();
    const changes = { conversationChanged, agentMembershipChanged };
    const session = 'agent:planner:project' as ConversationSessionId;
    appendConversationBatch({ projectRoot: root, changes }, [
      row(session, 'z', 'activity'),
      row(session, 'a'),
    ]);
    expect(conversationChanged).toHaveBeenLastCalledWith(session, 'a');
    expect(agentMembershipChanged).toHaveBeenCalledWith({ scope: 'card', cardId: 'project' });
    conversationChanged.mockClear();
    agentMembershipChanged.mockClear();
    appendConversationBatch({ projectRoot: root, changes }, [row(session, 'later')]);
    expect(conversationChanged).toHaveBeenCalledWith(session, 'later');
    expect(agentMembershipChanged).not.toHaveBeenCalled();
  });
});

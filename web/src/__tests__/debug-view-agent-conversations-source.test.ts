import { describe, expect, it } from 'vitest';

import debugViewSource from '../views/DebugView.vue?raw';
import debugStoreSource from '../stores/debug.ts?raw';

describe('DebugView agent conversations source', () => {
  it('uses segment-backed agent APIs instead of legacy message/session directories', () => {
    expect(debugStoreSource).toContain('listAgentSessions');
    expect(debugStoreSource).toContain('getAgentConversation');
    expect(debugViewSource).toContain('ConversationTimeline');
    expect(debugViewSource).not.toContain('.saivage/agents/messages');
    expect(debugViewSource).not.toContain('.saivage/agents/sessions');
  });
});

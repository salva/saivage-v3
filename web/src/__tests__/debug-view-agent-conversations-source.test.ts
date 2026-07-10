import { describe, expect, it } from 'vitest';

import debugViewSource from '../views/DebugView.vue?raw';
import debugStoreSource from '../stores/debug.ts?raw';

describe('DebugView agent conversations source', () => {
  it('uses active conversation agent APIs instead of obsolete message/session directories', () => {
    expect(debugStoreSource).toContain('listAgentSessions');
    expect(debugStoreSource).toContain('getAgentConversation');
    expect(debugViewSource).toContain('ConversationTimeline');
    expect(debugViewSource).not.toContain('.saivage/agents/messages');
    expect(debugViewSource).not.toContain('.saivage/agents/sessions');
  });
});

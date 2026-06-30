import { describe, expect, it } from 'vitest';

import debugViewSource from '../views/DebugView.vue?raw';

describe('DebugView agent conversations source', () => {
  it('uses segment-backed agent APIs instead of legacy message/session directories', () => {
    expect(debugViewSource).toContain('listAgentSessions');
    expect(debugViewSource).toContain('getAgentConversation');
    expect(debugViewSource).not.toContain('.saivage/agents/messages');
    expect(debugViewSource).not.toContain('.saivage/agents/sessions');
  });
});

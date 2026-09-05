import { describe, expect, it } from 'vitest';

import debugViewSource from '../views/DebugView.vue?raw';
import agentsPanelSource from '../components/debug/AgentsPanel.vue?raw';
import debugStoreSource from '../stores/debug.ts?raw';
import debugDetailSource from '../components/agents/DebugAgentDetail.vue?raw';

describe('DebugView agent conversations source', () => {
  it('uses active conversation agent APIs instead of obsolete message/session directories', () => {
    expect(debugStoreSource).not.toContain('listAgentSessions');
    expect(debugStoreSource).not.toContain('getAgentConversation');
    expect(debugViewSource).toContain('useAgentStore');
    expect(debugDetailSource).toContain('ConversationTimeline');
    expect(agentsPanelSource).toContain('DebugAgentDetail');
    expect(agentsPanelSource).not.toMatch(/useRoute|useRouter|use\w+Store|storeToRefs/);
    expect([debugViewSource, agentsPanelSource].join('\n')).not.toContain('.saivage/agents/messages');
    expect([debugViewSource, agentsPanelSource].join('\n')).not.toContain('.saivage/agents/sessions');
  });
});

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import McpPanel from '../components/debug/McpPanel.vue';

describe('MCP observation panel', () => {
  it('shows starting, source, retained containment blocker and safe associations without controls', () => {
    const wrapper = mount(McpPanel, {
      props: {
        servers: [
          {
            name: 'new',
            transport: 'stdio',
            status: 'starting',
            definitionSource: 'agent',
            policy: { controllerCardId: 'project', exposure: 'subtree' },
            availableActions: [], ready: false, containment: 'pending', failureReason: null, containmentBoundary: 'local_process_group',
            processId: 'launch-1',
            bindingId: '11111111-1111-4111-8111-111111111111',
            toolCount: 0,
            tools: [],
          },
          {
            name: 'old',
            transport: 'streamable-http',
            status: 'error',
            definitionSource: null,
            policy: { controllerCardId: 'card-a', exposure: 'card' },
            availableActions: ['mcp_server_control'], ready: false, containment: 'failed', failureReason: 'containment_failed', containmentBoundary: 'local_connection',
            processId: null,
            bindingId: null,
            toolCount: 0,
            tools: [],
          },
        ],
        loading: false,
        error: null,
        serverCount: 2,
        toolCount: 0,
        totalInvocations: 0,
        totalErrors: 0,
        lastRefreshed: null,
      },
    });
    expect(wrapper.find('.mcp-status-starting').text()).toBe('starting');
    for (const text of [
      'agent',
      'launch-1',
      '11111111-1111-4111-8111-111111111111',
      'Absent · retained owner',
      'failed · name blocked',
      'Project-wide', 'card-a', 'Controller card only', 'Not ready', 'pending', 'local_connection',
    ])
      expect(wrapper.text()).toContain(text);
    expect(wrapper.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });
});

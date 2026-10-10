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
            containmentFailed: false,
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
            containmentFailed: true,
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
      'Failed · name blocked',
    ])
      expect(wrapper.text()).toContain(text);
    expect(wrapper.findAll('button')).toHaveLength(0);
    wrapper.unmount();
  });
});

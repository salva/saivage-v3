import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceHeader from '../components/layout/WorkspaceHeader.vue';

function mountHeader(connectionState: 'connected' | 'connecting' | 'offline' | 'unauthorized') {
  return mount(WorkspaceHeader, {
    props: {
      sectionTitle: 'Dashboard',
      connectionState,
      runtimeStatus: 'running',
      runtimeStatusLabel: 'running',
      runtimeModeLabel: 'Running',
      runtimeModeDetail: 'Root run active.',
    },
  });
}

describe('WorkspaceHeader', () => {
  it('keeps bad-token websocket state visibly unauthorized', () => {
    const wrapper = mountHeader('unauthorized');
    const chip = wrapper.findAll('.header-chip')[0];

    expect(chip.text()).toContain('Unauthorized');
    expect(chip.classes()).toContain('ws-unauthorized');
  });


  it('does not combine socket authorization with REST authorization', () => {
    const unauthorized = mount(WorkspaceHeader, {
      props: {
        sectionTitle: 'Dashboard',
        connectionState: 'unauthorized',
        runtimeStatus: 'running',
        runtimeStatusLabel: 'running',
        runtimeModeLabel: 'Running',
        runtimeModeDetail: 'Root run active.',
        isUnauthorized: true,
      },
    });
    expect(unauthorized.findAll('.header-chip')[0].text()).toContain('Unauthorized');
    expect(unauthorized.findAll('.header-chip')[0].attributes('title')).toContain('WebSocket');
    expect(unauthorized.findAll('.header-chip')[2].attributes('title')).toContain('runtime REST request');
  });

  it('keeps runtime status observable without exposing header execution controls', async () => {
    const wrapper = mountHeader('connected');
    const runtimeChip = wrapper.findAll('.header-chip')[1];

    expect(runtimeChip.text()).toContain('Running');
    expect(runtimeChip.attributes('title')).toContain('Ask the Analyst');
    expect(wrapper.findAll('.header-chip')).toHaveLength(2);
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Pause');
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Resume');
    await runtimeChip.trigger('click');
    expect(wrapper.emitted('toggle-pause')).toBeUndefined();
  });

  it('does not render the project name inside the workspace header', () => {
    const wrapper = mountHeader('connected');

    expect(wrapper.find('.project-name').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('saivage-v3');
  });
});

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceHeader from '../components/layout/WorkspaceHeader.vue';

function mountHeader(connectionState: 'connected' | 'connecting' | 'offline' | 'unauthorized' | 'no-token') {
  return mount(WorkspaceHeader, {
    props: {
      sectionTitle: 'Dashboard',
      projectName: 'saivage-v3',
      connectionState,
      runtimeStatus: 'running',
      runtimeStatusLabel: 'running',
      runtimeModeLabel: 'Running',
      runtimeModeDetail: 'Root run active.',
      hasToken: true,
      liveUpdateLabel: undefined,
    },
  });
}

describe('WorkspaceHeader', () => {
  it('renders missing-token websocket state as neutral instead of unauthorized', () => {
    const wrapper = mountHeader('no-token');
    const chip = wrapper.findAll('.header-chip')[0];

    expect(chip.text()).toContain('NO TOKEN');
    expect(chip.classes()).toContain('ws-no-token');
    expect(chip.classes()).not.toContain('ws-unauthorized');
  });

  it('keeps bad-token websocket state visibly unauthorized', () => {
    const wrapper = mountHeader('unauthorized');
    const chip = wrapper.findAll('.header-chip')[0];

    expect(chip.text()).toContain('WS UNAUTH');
    expect(chip.classes()).toContain('ws-unauthorized');
  });


  it('does not mask auth websocket states with derived live update labels', () => {
    const noToken = mount(WorkspaceHeader, {
      props: {
        sectionTitle: 'Dashboard',
        projectName: 'saivage-v3',
        connectionState: 'no-token',
        runtimeStatus: 'running',
        runtimeStatusLabel: 'running',
        runtimeModeLabel: 'Running',
        runtimeModeDetail: 'Root run active.',
        hasToken: false,
        liveUpdateLabel: 'Live updates offline',
      },
    });
    expect(noToken.findAll('.header-chip')[0].text()).toContain('NO TOKEN');

    const unauthorized = mount(WorkspaceHeader, {
      props: {
        sectionTitle: 'Dashboard',
        projectName: 'saivage-v3',
        connectionState: 'unauthorized',
        runtimeStatus: 'running',
        runtimeStatusLabel: 'running',
        runtimeModeLabel: 'Running',
        runtimeModeDetail: 'Root run active.',
        isUnauthorized: true,
        hasToken: true,
        liveUpdateLabel: 'Live updates unauthorized',
      },
    });
    expect(unauthorized.findAll('.header-chip')[0].text()).toContain('WS UNAUTH');
  });

  it('keeps runtime status observable without exposing header execution controls', async () => {
    const wrapper = mountHeader('connected');
    const runtimeChip = wrapper.findAll('.header-chip')[1];

    expect(runtimeChip.text()).toContain('Running');
    expect(runtimeChip.attributes('title')).toContain('Dashboard → Runtime Console');
    expect(wrapper.findAll('.header-chip')).toHaveLength(2);
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Pause');
    expect(wrapper.findAll('button').map((button) => button.text())).not.toContain('Resume');
    await runtimeChip.trigger('click');
    expect(wrapper.emitted('toggle-pause')).toBeUndefined();
  });
});
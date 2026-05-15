import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import WorkspaceHeader from '../components/layout/WorkspaceHeader.vue';

function mountHeader(connectionState: 'connected' | 'connecting' | 'offline' | 'unauthorized' | 'no-token') {
  return mount(WorkspaceHeader, {
    props: {
      sectionTitle: 'Dashboard',
      projectName: 'saivage-v3',
      connectionState,
      runtimeStatus: 'unknown',
      runtimeStatusLabel: 'unknown',
      isPaused: false,
    },
  });
}

describe('WorkspaceHeader', () => {
  it('renders missing-token websocket state as neutral instead of unauthorized', () => {
    const wrapper = mountHeader('no-token');
    const chip = wrapper.find('.ws-chip');

    expect(chip.text()).toContain('NO TOKEN');
    expect(chip.classes()).toContain('ws-no-token');
    expect(chip.classes()).not.toContain('ws-unauthorized');
  });

  it('keeps bad-token websocket state visibly unauthorized', () => {
    const wrapper = mountHeader('unauthorized');
    const chip = wrapper.find('.ws-chip');

    expect(chip.text()).toContain('WS UNAUTH');
    expect(chip.classes()).toContain('ws-unauthorized');
  });
});
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import OperatorControlPanel from '../components/debug/OperatorControlPanel.vue';

describe('Operator observation panel', () => {
  it('presents current diagnostic and project lifecycle guidance and emits Refresh', async () => {
    const wrapper = mount(OperatorControlPanel, {
      props: {
        runtime: null, runtimeLoaded: true, runtimeLoading: false, runtimeError: null,
        runtimeRefreshError: null, runtimeLastFetchedAt: null, runtimeStatusLabel: 'stopped',
        currentCardId: null, operatorPanelBusy: false,
      },
    });
    const text = wrapper.text().replace(/\s+/g, ' ');
    expect(text).toContain('Ask the Analyst to run, pause, resume, or stop the project');
    expect(wrapper.get('[role="note"]').text().replace(/\s+/g, ' ')).toContain('System is diagnostic-only.');
    expect(text).toContain('stopping the project does not shut down the server.');
    expect(text).toContain('Cockpit shows current runtime and activation ownership');
    expect(text).toContain('Open System > Errors for durable runtime issues.');
    const refresh = wrapper.get('button');
    expect(refresh.text()).toBe('Refresh');
    await refresh.trigger('click');
    expect(wrapper.emitted('refresh')).toEqual([[]]);
    await wrapper.setProps({ operatorPanelBusy: true });
    expect(refresh.attributes('disabled')).toBeDefined();
    wrapper.unmount();
  });
});

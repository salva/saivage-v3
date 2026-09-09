import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import CompactionProgressBanner from '../components/agents/CompactionProgressBanner.vue';
import agentSource from '../components/agents/AgentConversationView.vue?raw';
import debugSource from '../components/agents/DebugAgentDetail.vue?raw';

describe('selected conversation compaction progress', () => {
  afterEach(() => vi.useRealTimers());

  it('shows completed calls, in-flight state, elapsed time, and last-known status without leaking its timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T10:00:05.000Z'));
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const wrapper = mount(CompactionProgressBanner, { props: { progress: { strategy: 'preventive', started_at: '2026-09-08T10:00:00.000Z', folds_done: 2, fold_in_flight: true }, lastKnown: true } });
    expect(wrapper.text()).toContain('Compacting history — 2 summary calls completed');
    expect(wrapper.text()).toContain('Summary call in flight');
    expect(wrapper.text()).toContain('Elapsed 5s');
    expect(wrapper.text()).toContain('Last-known progress');
    wrapper.unmount();
    expect(clear).toHaveBeenCalled();
    clear.mockRestore();
  });

  it('is installed only in Agents and Debug selected conversation details', () => {
    expect(agentSource).toContain('<CompactionProgressBanner');
    expect(debugSource).toContain('<CompactionProgressBanner');
  });
});

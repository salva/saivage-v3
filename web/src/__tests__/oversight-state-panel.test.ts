import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import StatePanel from '../components/debug/StatePanel.vue';
import { formatRecentTimestamp } from '../utils/timestamp';

beforeEach(() => { setActivePinia(createPinia()); });
afterEach(() => { vi.useRealTimers(); });
const props = { runtime: null, runtimeLoaded: true, runtimeLoading: false, runtimeError: null, runtimeRefreshing: false, runtimeRefreshError: null, currentCardId: null };
const base = { agent_name: 'oversight', session_id: 'agent:oversight:global', enabled: true, eligible: false, eligibility_reason: 'stopped' as const, state: 'unavailable' as const, remaining_wait_ms: null, last_attempt: null, last_successful_at: null, service_epoch: '2026-09-14T00:00:00.000Z' };
const waiting = { ...base, eligible: true, eligibility_reason: null, state: 'waiting' as const, remaining_wait_ms: 541_000.5 };

describe('Debug Project Oversight diagnostic', () => {
  it.each([
    ['unavailable', base],
    ['disabled', { ...base, enabled: false, eligibility_reason: 'disabled' as const }],
    ['waiting', waiting],
    ['checking', { ...base, eligibility_reason: 'check_in_flight' as const, state: 'checking' as const, last_attempt: { outcome: 'cancelled' as const, settled_at: '2026-09-14T01:00:00.000Z' } }],
  ])('renders %s without inventing absent timestamps', (_label, oversight) => {
    const wrapper = mount(StatePanel, { props: { ...props, oversight } });
    const text = wrapper.get('[data-testid="debug-oversight-state"]').text();
    expect(text).toContain(oversight.state); expect(text).toContain('Project Oversight');
    expect(text).toContain(oversight.session_id); expect(text).toContain('Service epoch:');
    expect(text).not.toContain('1/1/1970'); expect(text).toContain('Last success:none');
    if (oversight.remaining_wait_ms === null) expect(text).toContain('No armed wait');
    if (oversight.last_attempt) expect(text).toContain(formatRecentTimestamp(oversight.last_attempt.settled_at));
    wrapper.unmount();
  });

  it('keeps a last-observed rounded-up duration across client sleep and refresh failure, then accepts a fresh sample', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-14T01:51:00Z'));
    const oversight = { ...waiting, last_successful_at: '2026-09-13T21:00:00.000Z' };
    const wrapper = mount(StatePanel, { props: { ...props, oversight } });
    const panel = wrapper.get('[data-testid="debug-oversight-state"]');
    expect(panel.text()).toContain('Remaining timer wait at last observation:About 9m 2s');
    expect(wrapper.get('[data-testid="oversight-wait-explanation"]').isVisible()).toBe(true);
    expect(panel.text()).toContain('Host sleep can pause this wait; no wall-clock check deadline or catch-up is promised.');
    vi.setSystemTime(new Date('2026-09-14T05:00:00Z'));
    await wrapper.setProps({ runtimeRefreshError: 'Refresh failed; last observation retained' });
    expect(wrapper.text()).toContain('Refresh failed; last observation retained');
    expect(panel.text()).toContain('About 9m 2s');
    expect(panel.text()).not.toMatch(/Next due|overdue/i);
    expect(panel.text()).toContain(formatRecentTimestamp(oversight.last_successful_at));
    await wrapper.setProps({ oversight: { ...oversight, remaining_wait_ms: 60_001 }, runtimeRefreshError: null });
    expect(panel.text()).toContain('About 1m 1s');
    await wrapper.setProps({ oversight: { ...oversight, remaining_wait_ms: 0 } });
    expect(panel.text()).toContain('Timer wait elapsed; check not yet observed');
    expect(panel.text()).toContain('State:waiting');
    wrapper.unmount();
  });
});

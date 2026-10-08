import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline } from '../../utils/agent-timeline';
import { call, result, entry, processData } from '../tool-presenters/fixtures';

describe('ordered shared ConversationTimeline', () => {
  it('renders one exchange at the call position with separate source anchors and chronological diagnostics', async () => {
    const c = call('run_command', { command: 'npm test' });
    const correction = entry('correction', 'text', 'Correction before settlement');
    const diagnostic = entry('diagnostic', 'model_issue', '{"message":"provider interruption"}');
    const r = result('run_command', { ...processData, exit_code: 1 }, { round_id: 'r-user-0000000000000000000000000000000b' });
    const read = call('read', { path: 'one' }, 'read-one');
    const other = call('read', { path: 'two' }, 'read-two');
    const timeline = entriesToTimeline([c, correction, diagnostic, r, read, other]);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }] });
    await router.push('/'); await router.isReady();
    const wrapper = mount(ConversationTimeline, { props: { timeline, expandedIds: new Set(['call', 'read-one', 'read-two']) }, global: { plugins: [router] }, attachTo: document.body });
    expect(wrapper.findAll('[data-entry-id]').map((row) => row.attributes('data-entry-id'))).toEqual(['call', 'result', 'correction', 'diagnostic', 'read-one', 'read-two']);
    expect(wrapper.findAll('.tool-chip')).toHaveLength(3);
    expect(wrapper.findAll('.tool-chip')[0].text()).toContain('Process failed · exit 1');
    expect(wrapper.findAll('.tool-chip')[0].text()).toContain('2 retained entries between request and result');
    expect(wrapper.find('[data-entry-id="result"]').text()).toContain(r.timestamp);
    expect(wrapper.find('[data-entry-id="call"]').text()).toContain('npm test');
    wrapper.unmount();
  });
  it('renders unmatched results with no requested-context substitution and no grouping', () => {
    const r = result('read', { metadata_only: true });
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([r]), expandedIds: new Set(['result']) } });
    expect(wrapper.find('.tool-result').attributes('data-entry-id')).toBe('result');
    expect(wrapper.text()).toContain('Requested context unavailable');
    expect(wrapper.text()).toContain('Metadata only');
    expect(wrapper.find('.tool-group').exists()).toBe(false);
  });
  it('discloses only typed recorded system text at its exact position, leaving refusal/diagnostic/activation status visible', async () => {
    const c = call('read', { path: 'one' });
    const system = { ...entry('recorded-node', 'text', 'Node-looking recorded prose final-Z'), role: 'system' as const };
    const diagnostic = { ...entry('diagnostic', 'model_issue', '{"message":"visible issue"}'), role: 'system' as const };
    const refusal = { ...entry('refusal', 'content_policy_refusal', '{}'), role: 'system' as const };
    const r = result('read', { metadata_only: true });
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([c, system, diagnostic, refusal, r]), expandedIds: new Set(['call']) } });
    expect(wrapper.findAll('[data-entry-id]').map(row => row.attributes('data-entry-id'))).toEqual(['call', 'result', 'recorded-node', 'diagnostic', 'refusal']);
    const details = wrapper.get('.recorded-system-context');
    expect((details.element as HTMLDetailsElement).open).toBe(false);
    expect(details.text()).toContain(system.id);
    expect(details.text()).toContain(system.content);
    expect(wrapper.find('[data-entry-id="diagnostic"] details.recorded-system-context').exists()).toBe(false);
    expect(wrapper.find('[data-entry-id="refusal"] details').exists()).toBe(false);
  });
});

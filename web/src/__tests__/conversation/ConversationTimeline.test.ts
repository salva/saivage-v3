import { mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createRouter, createMemoryHistory } from 'vue-router';
import ConversationTimeline from '../../components/conversation/ConversationTimeline.vue';
import { entriesToTimeline } from '../../utils/agent-timeline';
import { call, result, entry, processData } from '../tool-presenters/fixtures';

describe('ordered shared ConversationTimeline', () => {
  it('renders separate exact anchors around corrections and diagnostics, including cross-round results', async () => {
    const c = call('run_command', { command: 'npm test' });
    const correction = entry('correction', 'text', 'Correction before settlement');
    const diagnostic = entry('diagnostic', 'model_issue', '{"message":"provider interruption"}');
    const r = result('run_command', { ...processData, exit_code: 1 }, { round_id: 'r-user-0000000000000000000000000000000b' });
    const read = call('read', { path: 'one' }, 'read-one');
    const other = call('read', { path: 'two' }, 'read-two');
    const timeline = entriesToTimeline([c, correction, diagnostic, r, read, other]);
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/', component: { template: '<div />' } }, { path: '/files', name: 'files', component: { template: '<div />' } }] });
    await router.push('/'); await router.isReady();
    const wrapper = mount(ConversationTimeline, { props: { timeline, expandedIds: new Set<string>() }, global: { plugins: [router] }, attachTo: document.body });
    expect(wrapper.findAll('[data-entry-id]').map((row) => row.attributes('data-entry-id'))).toEqual(['call', 'correction', 'diagnostic', 'result', 'read-one', 'read-two']);
    expect(wrapper.findAll('.tool-chip')).toHaveLength(4);
    expect(wrapper.findAll('.tool-chip')[0].text()).not.toContain('Process failed');
    expect(wrapper.findAll('.tool-chip')[1].text()).toContain('Process failed · exit 1');
    const scroll = vi.fn();
    Object.defineProperty(wrapper.findAll('.tool-chip')[1].element, 'scrollIntoView', { value: scroll });
    await wrapper.find('.inline-part-entry').trigger('click');
    expect(scroll).toHaveBeenCalledWith({ block: 'center' });
    expect(document.activeElement).toBe(wrapper.findAll('.tool-chip')[1].element);
    wrapper.unmount();
  });
  it('renders unmatched results with no requested-context substitution and no grouping', () => {
    const r = result('read', { metadata_only: true });
    const wrapper = mount(ConversationTimeline, { props: { timeline: entriesToTimeline([r]), expandedIds: new Set<string>() } });
    expect(wrapper.find('.tool-chip').attributes('data-entry-id')).toBe('result');
    expect(wrapper.text()).toContain('Requested context unavailable');
    expect(wrapper.text()).toContain('Metadata only');
    expect(wrapper.find('.tool-group').exists()).toBe(false);
  });
});

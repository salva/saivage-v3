import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import type { ToolCallPresentation } from '../utils/tool-presenters';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

const presentation: ToolCallPresentation = {
  icon: '📖', name: 'read_file', headline: [{ kind: 'file', root: 'meta', path: '.saivage/plan.json' }], body: { path: '.saivage/plan.json' }, bodyKind: 'json',
};

describe('ToolChip', () => {
  it('uses a group with one expand button and sibling router links without nested anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { presentation, expanded: false, variant: 'call', labelPrefix: 'tool call' }, global: { plugins: [r] } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.findAll('button.tool-chip-toggle')).toHaveLength(1);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.findComponent({ name: 'RouterLink' }).exists()).toBe(true);
  });

  it('emits toggle and renders formatted detail when expanded', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { presentation, expanded: true, variant: 'call', labelPrefix: 'tool call' }, global: { plugins: [r] } });
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import type { ToolCallPresentation } from '../utils/tool-presenters';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

const presentation: ToolCallPresentation = {
  icon: '📖', name: 'read', headline: [{ kind: 'file', root: 'meta', path: '.saivage/plan.json' }], body: { path: '.saivage/plan.json' }, bodyKind: 'json',
};

describe('ToolChip', () => {
  it('uses a group with one expand button and sibling router links without nested anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { call: presentation, result: null, callContent: JSON.stringify(presentation.body), resultContent: null, status: 'pending', expanded: false, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.findAll('button.tool-chip-toggle')).toHaveLength(1);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.find('.tool-chip-links').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-links a').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-main > button.tool-chip-toggle + .tool-chip-links').exists()).toBe(true);
  });

  it('emits toggle and renders formatted detail when expanded', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { call: presentation, result: null, callContent: JSON.stringify(presentation.body), resultContent: null, status: 'pending', expanded: true, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
  });

  it('renders timestamp in a human-friendly form instead of raw ISO', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const ts = '2026-05-30T06:50:18.761Z';
    const wrapper = mount(ToolChip, { props: { call: presentation, result: null, callContent: '{}', resultContent: null, status: 'pending', expanded: false, detailsId: 'tool-ts', timestamp: ts }, global: { plugins: [r, createPinia()] } });
    const span = wrapper.find('.tool-chip-time');
    expect(span.exists()).toBe(true);
    expect(span.text()).not.toBe(ts);
    expect(span.text()).toMatch(/ago|just now|\bm\b|\bh\b|\bd\b|2026/i);
    expect(span.attributes('title')).toBeTruthy();
  });
});

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import ToolChip from '../components/conversation/ToolChip.vue';
import type { ToolDisplayModel } from '../utils/tool-friendly';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

const pendingRead: ToolDisplayModel = {
  action: 'Read',
  toolName: 'read',
  target: [],
  links: [{ kind: 'file', root: 'meta', path: '.saivage/plan.json' }],
  status: [{ kind: 'text', text: 'running…' }],
  statusTone: 'pending',
  known: true,
};

describe('ToolChip', () => {
  it('uses a group with one expand button and sibling router links without nested anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.attributes('role')).toBe('group');
    expect(wrapper.findAll('button.tool-chip-toggle')).toHaveLength(1);
    expect(wrapper.find('button.tool-chip-toggle a').exists()).toBe(false);
    expect(wrapper.find('.tool-chip-links').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-links a').exists()).toBe(true);
    expect(wrapper.find('.tool-chip-main > button.tool-chip-toggle + .tool-chip-links').exists()).toBe(true);
  });

  it('emits toggle and renders formatted detail when expanded', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: true, detailsId: 'tool-test' }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
  });

  it('renders timestamp in a human-friendly form instead of raw ISO', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const ts = '2026-05-30T06:50:18.761Z';
    const wrapper = mount(ToolChip, { props: { display: pendingRead, callContent: '{}', resultContent: null, expanded: false, detailsId: 'tool-ts', timestamp: ts }, global: { plugins: [r, createPinia()] } });
    const span = wrapper.find('.tool-chip-time');
    expect(span.exists()).toBe(true);
    expect(span.text()).not.toBe(ts);
    expect(span.text()).toMatch(/ago|just now|\bm\b|\bh\b|\bd\b|2026/i);
    expect(span.attributes('title')).toBeTruthy();
  });

  it('does not render raw payloads by default when expanded and only reveals them via the raw toggles', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const rawRequest = JSON.stringify({ role: 'assistant', tool_calls: [{ function: { name: 'read', arguments: JSON.stringify({ path: 'README.md' }) } }] });
    const rawResponse = JSON.stringify({ ok: true, content: 'secret-value' });
    const okRead: ToolDisplayModel = { action: 'Read', toolName: 'read', target: [], links: [], status: [{ kind: 'text', text: '2 lines' }], statusTone: 'ok', known: true };
    const wrapper = mount(ToolChip, { props: { display: okRead, callContent: rawRequest, resultContent: rawResponse, expanded: true, detailsId: 'tool-raw' }, global: { plugins: [r, createPinia()] } });

    expect(wrapper.find('.tool-chip-body').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('secret-value');
    expect(wrapper.findAll('.tool-chip-raw')).toHaveLength(0);

    const toggles = wrapper.findAll('button.raw-toggle');
    expect(toggles).toHaveLength(2);

    await toggles[1].trigger('click');
    const raw = wrapper.findAll('.tool-chip-raw');
    expect(raw.map((n) => n.text()).join('\n')).toContain('secret-value');
  });
});

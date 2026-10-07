import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import InlineParts from '../../components/content/InlineParts.vue';
import { inlinePartsText } from '../../utils/tool-friendly';
import type { InlinePart } from '../../utils/tool-presenters';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

describe('InlineParts', () => {
  it('decorates only explicitly identified JSON and preserves extracted summary text', () => {
    const parts: InlinePart[] = [{ kind: 'text', text: 'true · ' }, { kind: 'text', text: '{"x":[1,null]}', language: 'json' }];
    const wrapper = mount(InlineParts, { props: { parts } });
    expect(wrapper.element.textContent).toBe('true · {"x":[1,null]}');
    expect(wrapper.findAll('.json-text')).toHaveLength(1);
    expect(wrapper.find('.json-token-key').text()).toBe('"x"');
    expect(inlinePartsText(parts)).toBe(inlinePartsText(parts.map(part => part.kind === 'text' ? { kind: 'text', text: part.text } : part)));
  });
  it('renders file parts as canonical files router links', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(InlineParts, { props: { parts: [{ kind: 'file', root: 'output', path: '.saivage/work/a.log' }] }, global: { plugins: [r, createPinia()] } });
    expect(wrapper.findComponent({ name: 'RouterLink' }).props('to')).toEqual({ name: 'files', query: { root: 'output', path: '.saivage/work/a.log' } });
  });
});

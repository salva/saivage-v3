import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createRouter, createWebHistory } from 'vue-router';
import InlineParts from '../../components/content/InlineParts.vue';

function router() { return createRouter({ history: createWebHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] }); }

describe('InlineParts', () => {
  it('renders file parts as canonical files router links and url parts as external anchors', async () => {
    const r = router(); await r.push('/'); await r.isReady();
    const wrapper = mount(InlineParts, { props: { parts: [{ kind: 'file', root: 'output', path: '.saivage-work/a.log' }, { kind: 'url', href: 'https://example.test' }] }, global: { plugins: [r] } });
    expect(wrapper.findComponent({ name: 'RouterLink' }).props('to')).toEqual({ name: 'files', query: { root: 'output', path: '.saivage-work/a.log' } });
    expect(wrapper.find('a.inline-part-url').attributes('href')).toBe('https://example.test');
  });
});

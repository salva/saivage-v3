import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import InlineParts from '../../components/content/InlineParts.vue';
import { pathParts } from '../../utils/tool-presenters/helpers';

describe('work tool file links', () => {
  it('carries exact decoded filename identities through the actual Files RouterLink', async () => {
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/files', name: 'files', component: { template: '<div />' } }] });
    await router.push('/files');
    await router.isReady();
    const names = ['#.txt', '%23.txt', '?.txt', '%3F.txt', 'space # percent% unicode-é'];
    const parts = names.flatMap(name => pathParts(`work:///cards/${encodeURIComponent(name)}`));
    const wrapper = mount(InlineParts, { props: { parts }, global: { plugins: [router] } });
    expect(wrapper.findAll('a').map(link => {
      const url = new URL(link.attributes('href')!, 'http://fixture.test');
      expect(url.hash).toBe('');
      expect(url.searchParams.get('root')).toBe('output');
      return url.searchParams.get('path');
    })).toEqual(names.map(name => `.saivage/work/cards/${name}`));
    for (const path of ['work:///cards/a?', 'work:///cards/a#', 'work:///cards/../a', 'work:///cards/%2Fa', 'work:///cards/%ZZ', 'work:///cards/%61']) {
      expect(pathParts(path)).toEqual([{ kind: 'text', text: path }]);
    }
  });
});

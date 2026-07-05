import { describe, expect, it } from 'vitest';
import { mount, RouterLinkStub } from '@vue/test-utils';
import EntityLink from '../components/entity/EntityLink.vue';

describe('EntityLink', () => {
  it('renders routed card labels with title context', () => {
    const wrapper = mount(EntityLink, {
      props: { kind: 'card', id: 'card-33', label: '1.2.1', title: 'Implement card refs' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    expect(wrapper.text()).toContain('1.2.1');
    expect(wrapper.text()).toContain('Implement card refs');
    expect(wrapper.findComponent(RouterLinkStub).props('to')).toEqual({ name: 'card-detail', params: { id: 'card-33' } });
  });

  it('renders file links to the file browser', () => {
    const wrapper = mount(EntityLink, {
      props: { kind: 'file', id: '.saivage-work/output.log', label: 'output.log' },
      global: { stubs: { RouterLink: RouterLinkStub } },
    });

    expect(wrapper.findComponent(RouterLinkStub).props('to')).toEqual({ name: 'files', query: { path: '.saivage-work/output.log' } });
  });

  it('renders missing entities as inert dashed labels', () => {
    const wrapper = mount(EntityLink, { props: { kind: 'card', id: 'card-404', missing: true } });

    expect(wrapper.text()).toContain('card-404');
    expect(wrapper.findComponent(RouterLinkStub).exists()).toBe(false);
    expect(wrapper.find('.entity-link--missing').exists()).toBe(true);
  });
});
